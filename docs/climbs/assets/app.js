/* FietsKlim database explorer — map + elevation profile (Climbfinder JSON) */

(function () {
  const state = {
    bundle: null,
    climbs: [],
    selectedId: null,
    map: null,
    baseLayers: null,
    activeBaseLayer: null,
    routeLayer: null,
    markers: [],
    chart: null,
    hoverMarker: null,
    activeClimb: null,
    indexRegions: [],
    currentRegionUrl: null,
    regionCache: new Map(),
    globalSearchReady: false,
    globalEntries: [],
    searchBusy: false,
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
    return (
      climb.name.toLowerCase().includes(q) ||
      (climb.region || "").toLowerCase().includes(q) ||
      (climb.tags || []).some((t) => t.toLowerCase().includes(q)) ||
      (climb.id || "").toLowerCase().includes(q)
    );
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
          ? `<div class="dataset-tag">${entry.regionTitle}</div>`
          : "";
      el.innerHTML = `
        <h3>${climb.name}</h3>
        ${datasetLine}
        <div class="meta">${formatKm(climb.stats.length_m)} · ${climb.stats.avg_gradient_pct}% gem. · +${formatM(climb.stats.elevation_gain_m)} · ${climb.region || ""}${steepestLabel(climb)}</div>
        <div>${tags} ${cf}</div>
      `;
      el.addEventListener("click", (e) => {
        if (e.target.tagName === "A") return;
        void selectClimbFromList(climb.id, entry.regionUrl);
      });
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
    if (state.globalSearchReady || state.searchBusy) return;
    state.searchBusy = true;
    renderList($("searchInput").value);
    try {
      for (const r of state.indexRegions) {
        if (!state.regionCache.has(r.url)) {
          state.regionCache.set(r.url, await loadJson(r.url));
        }
        const bundle = state.regionCache.get(r.url);
        for (const c of bundle.climbs || []) {
          state.globalEntries.push({
            climb: c,
            regionUrl: r.url,
            regionTitle: r.title,
            regionId: r.id,
          });
        }
      }
      state.globalSearchReady = true;
    } finally {
      state.searchBusy = false;
      renderList($("searchInput").value);
    }
  }

  async function selectClimbFromList(id, regionUrl) {
    if (regionUrl && regionUrl !== state.currentRegionUrl) {
      const select = $("regionSelect");
      if (select.value !== regionUrl) select.value = regionUrl;
      await loadRegion(regionUrl, { keepSearch: true, selectId: id });
    } else {
      selectClimb(id);
    }
  }

  function clearMapLayers() {
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

  function updateChart(climb) {
    state.activeClimb = climb;
    const points = profilePoints(climb);
    const elevValues = points.map((p) => p.y);
    const bounds = yAxisBounds(elevValues);
    const segGrad = segmentGradientsForChart(climb);
    const colorFn =
      typeof ClimbMetrics !== "undefined"
        ? (g) => ClimbMetrics.gradientColor(g)
        : (g) => (g >= 9 ? "#ea580c" : "#0f766e");

    if (state.chart) {
      state.chart.destroy();
      state.chart = null;
    }

    const ctx = $("profileChart").getContext("2d");
    state.chart = new Chart(ctx, {
      type: "line",
      data: {
        datasets: [
          {
            label: "Hoogte (m)",
            data: points,
            parsing: false,
            borderColor: "#0f766e",
            backgroundColor: "rgba(15,118,110,0.12)",
            fill: true,
            pointRadius: 0,
            borderWidth: 2.5,
            tension: 0.12,
            segment: {
              borderColor: (ctx) => {
                const idx = ctx.p1DataIndex;
                return colorFn(segGrad[idx] ?? segGrad[idx - 1] ?? 0);
              },
            },
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
          tooltip: {
            callbacks: {
              title: (items) => `${items[0].parsed.x.toFixed(2)} km`,
              label: (item) => {
                const idx = item.dataIndex;
                const g = segGrad[idx];
                const lines = [`${item.parsed.y.toFixed(1)} m hoogte`];
                if (g != null && Number.isFinite(g)) lines.push(`${g.toFixed(1)}% helling`);
                return lines;
              },
            },
          },
        },
        scales: {
          x: {
            type: "linear",
            title: { display: true, text: "Afstand (km)" },
            ticks: { maxTicksLimit: 8 },
          },
          y: {
            type: "linear",
            min: bounds.min,
            max: bounds.max,
            title: { display: true, text: "Hoogte (m)" },
          },
        },
        onHover: (_evt, elements) => {
          if (!elements.length || !state.routeLayer || !state.activeClimb) return;
          const idx = elements[0].index;
          const geoIdx = geometryIndexForProfile(state.activeClimb, idx);
          const [lng, lat] = state.activeClimb.geometry.coordinates[geoIdx];
          if (!state.hoverMarker) {
            state.hoverMarker = L.circleMarker([lat, lng], {
              radius: 7,
              color: "#b45309",
              fillColor: "#f59e0b",
              fillOpacity: 1,
            }).addTo(state.map);
          } else {
            state.hoverMarker.setLatLng([lat, lng]);
          }
        },
      },
    });

    $("profileTitle").textContent = climb.name;
    const st = climb.stats || {};
    const steep =
      st.steepest_100m_pct != null
        ? ` · steil 100 m ${st.steepest_100m_pct}% · steil 1 km ${st.steepest_1km_pct ?? "—"}%`
        : steepestLabel(climb);
    $("profileStats").textContent = `${formatKm(st.length_m)} · ${st.avg_gradient_pct}% gem. · max ${st.max_gradient_pct}%${steep} · +${formatM(st.elevation_gain_m)}`;
  }

  function selectClimb(id) {
    const climb = state.climbs.find((c) => c.id === id);
    if (!climb) return;
    state.selectedId = id;
    renderList($("searchInput").value);

    clearMapLayers();
    const latlngs = latLngsFromClimb(climb);
    state.routeLayer = L.polyline(latlngs, { color: "#0f766e", weight: 5, opacity: 0.9 }).addTo(state.map);
    state.markers.push(
      L.circleMarker(latlngs[0], { radius: 6, color: "#0369a1", fillColor: "#0ea5e9", fillOpacity: 1 }).addTo(state.map),
      L.circleMarker(latlngs[latlngs.length - 1], { radius: 6, color: "#15803d", fillColor: "#22c55e", fillOpacity: 1 }).addTo(state.map)
    );
    state.map.fitBounds(state.routeLayer.getBounds(), { padding: [30, 30] });
    updateChart(climb);

    if (window.location.hash !== `#${id}`) {
      history.replaceState(null, "", `#${id}`);
    }
  }

  function initMap() {
    if (state.map) return;
    if (typeof L === "undefined") {
      throw new Error("Leaflet (kaart) is niet geladen. Check netwerk/adblocker.");
    }
    state.map = L.map("map", { zoomControl: true });

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
  }

  async function loadRegion(url, options = {}) {
    const { keepSearch = false, selectId = null } = options;
    let bundle = state.regionCache.get(url);
    if (!bundle) {
      bundle = await loadJson(url);
      state.regionCache.set(url, bundle);
    }
    state.currentRegionUrl = url;
    state.bundle = bundle;
    state.climbs = bundle.climbs || [];
    const src = state.bundle.meta?.source?.name || "onbekend";
    $("datasetMeta").textContent = `${state.bundle.meta.title} · ${state.climbs.length} klimmen · bron: ${src} · ${state.bundle.meta.updated_at}`;

    if (!keepSearch) {
      $("searchInput").value = "";
    }

    renderList($("searchInput").value);

    if (state.climbs.length > 1 && !selectId) {
      const b = state.climbs.reduce(
        (acc, c) => {
          const [w, s, e, n] = c.bbox || [];
          if (w == null) return acc;
          return {
            minLng: Math.min(acc.minLng, w),
            minLat: Math.min(acc.minLat, s),
            maxLng: Math.max(acc.maxLng, e),
            maxLat: Math.max(acc.maxLat, n),
          };
        },
        { minLng: Infinity, minLat: Infinity, maxLng: -Infinity, maxLat: -Infinity }
      );
      if (Number.isFinite(b.minLng)) {
        state.map.fitBounds(
          [
            [b.minLat, b.minLng],
            [b.maxLat, b.maxLng],
          ],
          { padding: [24, 24] }
        );
      }
    }

    if (state.climbs.length) {
      const hash = window.location.hash.replace("#", "");
      const pick = selectId || (state.climbs.some((c) => c.id === hash) ? hash : state.climbs[0].id);
      selectClimb(pick);
    } else {
      clearMapLayers();
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
      opt.textContent = `${region.title} (${region.count})`;
      select.appendChild(opt);
    }

    select.addEventListener("change", () => {
      void loadRegion(select.value);
    });

    let searchTimer = null;
    $("searchInput").addEventListener("input", (e) => {
      const q = e.target.value.trim();
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        if (q) void ensureGlobalSearchIndex();
        else renderList("");
      }, q ? 180 : 0);
    });

    await loadRegion(select.value);
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
