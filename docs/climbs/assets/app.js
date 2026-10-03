/* FietsKlim database explorer — map + elevation profile */

(function () {
  const state = {
    bundle: null,
    climbs: [],
    selectedId: null,
    map: null,
    routeLayer: null,
    markers: [],
    chart: null,
    markerOnChart: null,
  };

  function $(id) {
    return document.getElementById(id);
  }

  async function loadJson(url) {
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
      el.innerHTML = `
        <h3>${climb.name}</h3>
        <div class="meta">${formatKm(climb.stats.length_m)} · ${climb.stats.avg_gradient_pct}% gem. · +${formatM(climb.stats.elevation_gain_m)} · ${climb.region || ""}</div>
        <div>${tags}</div>
      `;
      el.addEventListener("click", () => selectClimb(climb.id));
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
  }

  function updateChart(climb) {
    const dist = climb.profile.distances_m.map((d) => d / 1000);
    const elev = climb.profile.elevations_m;

    if (state.chart) state.chart.destroy();

    const ctx = $("profileChart").getContext("2d");
    state.chart = new Chart(ctx, {
      type: "line",
      data: {
        labels: dist,
        datasets: [
          {
            label: "Hoogte (m)",
            data: elev,
            borderColor: "#0f766e",
            backgroundColor: "rgba(15,118,110,0.15)",
            fill: true,
            pointRadius: 0,
            borderWidth: 2,
            tension: 0.15,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => `${items[0].label} km`,
              label: (item) => `${item.raw} m`,
            },
          },
        },
        scales: {
          x: {
            title: { display: true, text: "Afstand (km)" },
            ticks: { maxTicksLimit: 8 },
          },
          y: { title: { display: true, text: "Hoogte (m)" } },
        },
        onHover: (_evt, elements) => {
          if (!elements.length || !state.routeLayer) return;
          const idx = elements[0].index;
          const [lng, lat] = climb.geometry.coordinates[idx];
          if (!state.markerOnChart) {
            state.markerOnChart = L.circleMarker([lat, lng], {
              radius: 7,
              color: "#b45309",
              fillColor: "#f59e0b",
              fillOpacity: 1,
            }).addTo(state.map);
          } else {
            state.markerOnChart.setLatLng([lat, lng]);
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
      L.marker(latlngs[0], { title: "Start" }).addTo(state.map),
      L.marker(latlngs[latlngs.length - 1], { title: "Top" }).addTo(state.map)
    );
    state.map.fitBounds(state.routeLayer.getBounds(), { padding: [30, 30] });
    if (state.markerOnChart) {
      state.map.removeLayer(state.markerOnChart);
      state.markerOnChart = null;
    }
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
      opt.dataset.regionId = region.id;
      select.appendChild(opt);
    }

    async function loadRegion(url) {
      state.bundle = await loadJson(url);
      state.climbs = state.bundle.climbs || [];
      $("datasetMeta").textContent = `${state.bundle.meta.title} · ${state.climbs.length} klimmen · bijgewerkt ${state.bundle.meta.updated_at}`;
      renderList("");
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

  document.addEventListener("DOMContentLoaded", () => {
    init().catch((err) => {
      console.error(err);
      alert("Kon de klimdatabase niet laden. Zie console voor details.");
    });
  });
})();
