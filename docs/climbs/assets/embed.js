/**
 * Embed FietsKlim JSON on any site.
 *
 * <div id="my-climb-map" data-fietsklim data-dataset="https://.../nl-limburg.json" data-climb="cauberg-valkenburg"></div>
 * <script src="https://vccharlie.github.io/Climbfinder-scraper/climbs/assets/embed.js"></script>
 */
(function () {
  const CSS = `
  .fk-embed { font-family: Barlow, system-ui, sans-serif; border:1px solid #e2e8f0; border-radius:8px; overflow:hidden; }
  .fk-embed-map { height: 320px; }
  .fk-embed-profile { height: 140px; padding: 8px; background:#fff; }
  .fk-embed-title { font-size: 14px; font-weight: 700; color:#0f766e; margin:0 0 4px; }
  .fk-embed-meta { font-size: 12px; color:#475569; margin:0 0 6px; }
  `;

  function injectCss() {
    if (document.getElementById("fietsklim-embed-css")) return;
    const style = document.createElement("style");
    style.id = "fietsklim-embed-css";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  async function loadJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Dataset load failed: ${res.status}`);
    return res.json();
  }

  async function render(container, options) {
    injectCss();
    const datasetUrl = options.dataset;
    const climbId = options.climb;
    const bundle = await loadJson(datasetUrl);
    const climb =
      bundle.climbs.find((c) => c.id === climbId) || bundle.climbs[0];
    if (!climb) throw new Error("No climbs in dataset");

    container.classList.add("fk-embed");
    container.innerHTML = `
      <div class="fk-embed-title">${climb.name}</div>
      <div class="fk-embed-meta">${(climb.stats.length_m / 1000).toFixed(2)} km · ${climb.stats.avg_gradient_pct}% · +${climb.stats.elevation_gain_m} m</div>
      <div class="fk-embed-map"></div>
      <canvas class="fk-embed-profile"></canvas>
    `;

    const mapEl = container.querySelector(".fk-embed-map");
    const map = L.map(mapEl, { zoomControl: false, attributionControl: false });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18 }).addTo(map);
    const latlngs = climb.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    const line = L.polyline(latlngs, { color: "#0f766e", weight: 4 }).addTo(map);
    map.fitBounds(line.getBounds(), { padding: [12, 12] });

    if (window.Chart) {
      const canvas = container.querySelector(".fk-embed-profile");
      const elev = climb.profile.elevations_m;
      const minE = Math.min(...elev);
      const maxE = Math.max(...elev);
      const pad = Math.max(5, (maxE - minE) * 0.08);
      const points = climb.profile.distances_m.map((d, i) => ({
        x: d / 1000,
        y: elev[i],
      }));
      new Chart(canvas.getContext("2d"), {
        type: "line",
        data: {
          datasets: [
            {
              data: points,
              parsing: false,
              borderColor: "#0f766e",
              backgroundColor: "rgba(15,118,110,0.12)",
              fill: true,
              pointRadius: 0,
              borderWidth: 1.5,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { type: "linear", display: false },
            y: {
              min: Math.floor(minE - pad),
              max: Math.ceil(maxE + pad),
              ticks: { maxTicksLimit: 4 },
            },
          },
        },
      });
    }
  }

  function autoInit() {
    const nodes = document.querySelectorAll("[data-fietsklim]");
    nodes.forEach((el) => {
      render(el, {
        dataset: el.dataset.dataset,
        climb: el.dataset.climb,
      }).catch(console.error);
    });
  }

  window.FietsKlimDB = {
    render,
    autoInit,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoInit);
  } else {
    autoInit();
  }
})();
