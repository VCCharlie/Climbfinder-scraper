/* FietsKlim database explorer — map + elevation profile (Climbfinder JSON) */

(function () {
  const state = {
    bundle: null,
    climbs: [],
    selectedId: null,
    map: null,
    routeLayer: null,
    markers: [],
    chart: null,
    hoverMarker: null,
    activeClimb: null,
  };

  function $(id) {
    return document.getElementById(id);
  }

  async function loadJson(url) {
    const cfg = window.FIETSKLIM_AUTH_CONFIG;
    if (
      cfg?.useStorage &&
      typeof firebase !== "undefined" &&
      firebase.storage &&
      cfg.storageDataPrefix
    ) {
      const rel = url.replace(/^\.\//, "").replace(/^data\//, "");
      const path = `${cfg.storageDataPrefix}/${rel}`;
      const snap = await firebase.storage().ref(path).getDownloadURL();
      const res = await fetch(snap);
      if (!res.ok) throw new Error(`Kon dataset niet laden uit Storage (${res.status})`);
      return res.json();
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Kon dataset niet laden (${res.status})`);
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

  function renderList(filterText) {
    const list = $("climbList");
    const q = (filterText || "").trim().toLowerCase();
    list.innerHTML = "";
    const items = state.climbs.filter((c) => {
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        (c.region || "").toLowerCase().includes(q) ||
        (c.tags || []).some((t) => t.toLowerCase().includes(q))
      );
    });

    for (const climb of items) {
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
      el.innerHTML = `
        <h3>${climb.name}</h3>
        <div class="meta">${formatKm(climb.stats.length_m)} · ${climb.stats.avg_gradient_pct}% gem. · +${formatM(climb.stats.elevation_gain_m)} · ${climb.region || ""}</div>
        <div>${tags} ${cf}</div>
      `;
      el.addEventListener("click", (e) => {
        if (e.target.tagName === "A") return;
        selectClimb(climb.id);
      });
      list.appendChild(el);
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

  function updateChart(climb) {
    state.activeClimb = climb;
    const points = profilePoints(climb);
    const elevValues = points.map((p) => p.y);
    const bounds = yAxisBounds(elevValues);

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
            backgroundColor: "rgba(15,118,110,0.15)",
            fill: true,
            pointRadius: 0,
            borderWidth: 2,
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
          tooltip: {
            callbacks: {
              title: (items) => `${items[0].parsed.x.toFixed(2)} km`,
              label: (item) => `${item.parsed.y.toFixed(1)} m`,
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
    $("profileStats").textContent = `${formatKm(climb.stats.length_m)} · ${climb.stats.avg_gradient_pct}% gem. · max ${climb.stats.max_gradient_pct}% · +${formatM(climb.stats.elevation_gain_m)}`;
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
    state.map = L.map("map", { zoomControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap",
    }).addTo(state.map);
    state.map.setView([50.85, 5.88], 11);
  }

  async function init() {
    initMap();

    const index = await loadJson("data/index.json");
    const select = $("regionSelect");
    select.innerHTML = "";
    for (const region of index.regions) {
      const opt = document.createElement("option");
      opt.value = region.url;
      opt.textContent = `${region.title} (${region.count})`;
      select.appendChild(opt);
    }

    async function loadRegion(url) {
      state.bundle = await loadJson(url);
      state.climbs = state.bundle.climbs || [];
      const src = state.bundle.meta?.source?.name || "onbekend";
      $("datasetMeta").textContent = `${state.bundle.meta.title} · ${state.climbs.length} klimmen · bron: ${src} · ${state.bundle.meta.updated_at}`;
      renderList("");
      if (state.climbs.length > 1) {
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
        selectClimb(state.climbs.some((c) => c.id === hash) ? hash : state.climbs[0].id);
      }
    }

    select.addEventListener("change", () => loadRegion(select.value));
    $("searchInput").addEventListener("input", (e) => renderList(e.target.value));

    await loadRegion(select.value);
  }

  window.FietsKlimExplorer = { init, selectClimb, loadJson };

  document.addEventListener("fietsklim-authenticated", () => {
    init().catch((err) => {
      console.error(err);
      alert("Kon de klimdatabase niet laden. Zie console voor details.");
    });
  });
})();
