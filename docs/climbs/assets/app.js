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
  };

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

  /** Kaart: standaard alle regio’s; alleen zoekterm filtert weg. */
  function mapVisibleEntries() {
    const q = state.searchQuery.trim().toLowerCase();
    if (!q) return state.globalEntries;
    return state.globalEntries.filter(({ climb }) => climbMatchesQuery(climb, q));
  }

  /** Geselecteerde regio = highlight; andere klimmen blijven zichtbaar (gedimd). */
  function isEntryMapActive(entry) {
    const q = state.searchQuery.trim().toLowerCase();
    if (q) return climbMatchesQuery(entry.climb, q);
    if (state.currentRegionUrl) return entry.regionUrl === state.currentRegionUrl;
    return true;
  }

  function boundsForEntries(entries) {
    const bounds = [];
    for (const entry of entries) {
      const ll = climbLatLng(entry.climb);
      if (ll) bounds.push(ll);
    }
    return bounds;
  }

  function updateSearchHint() {
    const el = $("searchHint");
    if (!el) return;
    const q = state.searchQuery.trim();
    if (q) {
      const n = state.globalEntries.filter(({ climb }) => climbMatchesQuery(climb, q.toLowerCase())).length;
      el.textContent = `${n} treffer in alle regio’s — klik kaart of lijst.`;
    } else {
      const n = state.globalEntries.length;
      const reg = state.indexRegions.find((r) => r.url === state.currentRegionUrl);
      const regN = reg
        ? state.globalEntries.filter((e) => e.regionUrl === state.currentRegionUrl).length
        : 0;
      el.textContent =
        n > 0
          ? `Kaart: ${n} klimmen (alle regio’s). Lijst: ${reg ? regionTitleFromIndexEntry(reg) : "regio"} (${regN}). Klik klim (ook grijs) = regio wisselt mee.`
          : "Leeg = alle klimmen op kaart. Typ om te filteren.";
    }
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
    mountProfileExpandMap(state.activeClimb);
    mountProfileChart("profileChartFull", "chartFull", state.activeClimb, false);
    requestAnimationFrame(() => {
      setTimeout(() => {
        if (state.chartFull) state.chartFull.resize();
        state.profileExpandMap?.invalidateSize();
      }, 50);
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
    updateChart(climb);
    syncListHoverHighlight(climb.id);
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
    }, 50);
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

  function bindMapEntryInteraction(layer, entry) {
    layer.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
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
          setMobilePane("list");
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
    const activeEntries = entries.filter((e) => isEntryMapActive(e));
    const inactiveEntries = entries.filter((e) => !isEntryMapActive(e));
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
      line.bindTooltip(tip, { sticky: true, interactive: !isCoarsePointer() });
      state.viewportRoutesLayer.addLayer(line);
      const needsHit = isCoarsePointer() || isDim;
      if (needsHit) {
        const hit = L.polyline(latlngs, {
          color: "#000000",
          weight: isDim ? ROUTE_HIT_WEIGHT_DIM : ROUTE_HIT_WEIGHT_COARSE,
          opacity: 0,
          interactive: true,
        });
        hit.bindTooltip(
          isDim ? `${tip} — klik om regio «${regLabel || "?"}» te kiezen` : tip,
          { sticky: true, interactive: true }
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
          size: "sm",
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
      marker.bindTooltip(tip, {
        direction: "top",
        sticky: true,
        interactive: !isCoarsePointer(),
      });
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
    const entries = mapVisibleEntries();
    const fitBounds = [];
    if (fit && state.currentRegionUrl && !state.searchQuery.trim()) {
      const regionEntries = entries.filter((e) => e.regionUrl === state.currentRegionUrl);
      fitBounds.push(...boundsForEntries(regionEntries));
    } else {
      fitBounds.push(...boundsForEntries(entries));
    }
    for (const entry of entries) {
      const latlng = climbLatLng(entry.climb);
      if (!latlng) continue;
      const active = isEntryMapActive(entry);
      const touch = isCoarsePointer();
      const marker = L.circleMarker(latlng, {
        radius: touch ? (active ? 9 : 7) : active ? 6 : 4,
        color: active ? "#5b21b6" : "#94a3b8",
        weight: active ? 2 : 1,
        fillColor: active ? "#7c3aed" : "#cbd5e1",
        fillOpacity: active ? 0.9 : 0.55,
      });
      const reg = entry.regionTitle ? ` · ${displayRegionTitle(entry.regionTitle)}` : "";
      const activeTip = `${entry.climb.name}${reg}`;
      const dimTip = `${entry.climb.name}${reg}${reg ? " — klik = regio kiezen" : ""}`;
      marker.bindTooltip(active ? activeTip : dimTip, {
        direction: "top",
        sticky: true,
        interactive: !touch,
      });
      bindMapEntryInteraction(marker, entry);
      state.overviewCluster.addLayer(marker);
    }
    if (fit && fitBounds.length) {
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

    if (q && !state.globalSearchReady) {
      list.innerHTML = '<p class="list-hint">Zoekindex laden…</p>';
      return;
    }

    list.innerHTML = "";
    let items;
    if (q) {
      items = state.globalEntries
        .filter(({ climb }) => climbMatchesQuery(climb, q))
        .slice(0, 200);
    } else {
      items = state.climbs.map((climb) => ({
        climb,
        regionUrl: state.currentRegionUrl,
        regionTitle: state.bundle?.meta?.title || "",
      }));
    }

    if (q && !items.length) {
      list.innerHTML = '<p class="list-hint">Geen klimmen gevonden in alle regio’s.</p>';
      return;
    }

    for (const entry of items) {
      const climb = entry.climb;
      const el = document.createElement("div");
      el.className = "climb-item" + (climb.id === state.selectedId ? " active" : "");
      el.dataset.id = climb.id;
      const tags = (climb.tags || [])
        .slice(0, 3)
        .map((t) => `<span class="badge">${t}</span>`)
        .join("");
      const cf = climb.climbfinder?.url
        ? `<a href="${climb.climbfinder.url}" target="_blank" rel="noopener" class="text-teal-700 text-xs">Climbfinder</a>`
        : "";
      const datasetLine =
        q && entry.regionTitle
          ? `<div class="dataset-tag">${displayRegionTitle(entry.regionTitle)}</div>`
          : "";
      el.innerHTML = `
        <h3 class="climb-item-title">${categoryBadgeHtml(climb, "sm")}<span>${climb.name}</span></h3>
        ${datasetLine}
        <div class="meta">${formatKm(climb.stats.length_m)} · ${climb.stats.avg_gradient_pct}% gem. · +${formatM(climb.stats.elevation_gain_m)} · ${climb.region || ""}${steepestLabel(climb)}</div>
        <div>${tags} ${cf}</div>
      `;
      el.addEventListener("click", (e) => {
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
    if (q && state.globalEntries.length && items.length === 200) {
      const hint = document.createElement("p");
      hint.className = "list-hint";
      hint.textContent = "Eerste 200 resultaten — verfijn je zoekterm.";
      list.appendChild(hint);
    }
  }

  async function ensureGlobalSearchIndex() {
    if (state.searchBusy) return;
    if (state.globalSearchReady) return;
    state.searchBusy = true;
    renderList(state.searchQuery);
    try {
      state.globalEntries = [];
      for (const r of state.indexRegions) {
        if (!state.regionCache.has(r.url)) {
          state.regionCache.set(r.url, await loadJson(r.url));
        }
        const bundle = state.regionCache.get(r.url);
        for (const c of bundle.climbs || []) {
          state.globalEntries.push({
            climb: c,
            regionUrl: r.url,
            regionTitle: r.displayTitle || displayRegionTitle(r.title),
            regionId: r.id,
          });
        }
      }
      state.globalSearchReady = true;
      syncOverviewMarkers();
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
    if (window.location.hash) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    clearDetailSelection();
    renderList("");
    if (state.globalSearchReady) syncOverviewMarkers({ fit: true });
    updateSearchHint();
  }

  async function selectClimbFromList(id, regionUrl) {
    if (regionUrl && regionUrl !== state.currentRegionUrl) {
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
    mountProfileChart("profileChartMini", "chartMini", climb, true);
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

    if (window.location.hash !== `#${id}`) {
      history.replaceState(null, "", `#${id}`);
    }
  }

  function initMap() {
    if (state.map) return;
    if (typeof L === "undefined") {
      throw new Error("Leaflet (kaart) is niet geladen. Check netwerk/adblocker.");
    }
    state.map = L.map("map", {
      zoomControl: true,
      tapTolerance: isCoarsePointer() ? 25 : 15,
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
    });
  }

  async function loadRegion(url, options = {}) {
    const { keepSearch = false, selectId = null } = options;
    const hashOnEntry = window.location.hash.replace("#", "");
    let bundle = state.regionCache.get(url);
    if (!bundle) {
      bundle = await loadJson(url);
      state.regionCache.set(url, bundle);
    }
    state.currentRegionUrl = url;
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

    const pick =
      selectId ||
      (hashOnEntry && state.climbs.some((c) => c.id === hashOnEntry) ? hashOnEntry : null);

    if (pick && state.climbs.some((c) => c.id === pick)) {
      selectClimb(pick);
      return;
    }

    clearDetailSelection();
    if (state.globalSearchReady) {
      syncOverviewMarkers({ fit: !pick && !state.searchQuery.trim() });
    }
  }

  async function init() {
    initMap();

    const index = await loadJson("data/index.json");
    state.indexRegions = index.regions || [];
    const select = $("regionSelect");
    select.innerHTML = "";
    for (const region of state.indexRegions) {
      const opt = document.createElement("option");
      opt.value = region.url;
      opt.textContent = `${regionTitleFromIndexEntry(region)} (${region.count})`;
      select.appendChild(opt);
    }

    select.addEventListener("change", () => {
      void loadRegion(select.value).then(() => {
        if (state.globalSearchReady && state.mapMode === "overview") {
          syncOverviewMarkers({ fit: true });
        } else if (state.mapMode === "local") {
          refreshViewportClimbs();
        }
      });
    });

    const searchInput = $("searchInput");
    let searchTimer = null;

    async function applySearchQuery(raw) {
      const q = raw.trim();
      state.searchQuery = q;
      if (!q) {
        resetSearchToOverview();
        return;
      }
      await ensureGlobalSearchIndex();
      clearDetailSelection();
      syncOverviewMarkers({ fit: true });
      renderList(q);
      updateSearchHint();
    }

    searchInput.addEventListener("input", (e) => {
      const q = e.target.value;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        void applySearchQuery(q);
      }, 180);
    });

    searchInput.addEventListener("search", () => {
      if (!searchInput.value.trim()) resetSearchToOverview();
    });

    initMobileViewSwitch();
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

    await ensureGlobalSearchIndex();
    await loadRegion(select.value);

    const deepLink = window.location.hash.replace("#", "");
    if (deepLink && !state.selectedId) {
      const hit = state.globalEntries.find(({ climb }) => climb.id === deepLink);
      if (hit) await selectClimbFromList(hit.climb.id, hit.regionUrl);
    }
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

  function bootExplorer() {
    if (!isUnlocked()) return;
    if (window.__fietsklimExplorerBooted) return;
    window.__fietsklimExplorerBooted = true;
    const meta = $("datasetMeta");
    if (meta) meta.textContent = "Dataset laden…";
    init()
      .then(() => {
        requestAnimationFrame(() => {
          setTimeout(refreshMapSize, 100);
          setTimeout(refreshMapSize, 500);
        });
      })
      .catch((err) => {
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
      });
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
