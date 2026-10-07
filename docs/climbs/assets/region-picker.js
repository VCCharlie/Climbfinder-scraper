/**
 * Climbfinder regio op kaart — import.html (wereldoverzicht → klik regio → import).
 */
(function (global) {
  const STATUS = {
    none: { label: "Niet op kaart", color: "#94a3b8", fill: "#f1f5f9" },
    partial: { label: "Deels geïmporteerd", color: "#d97706", fill: "#fef3c7" },
    cache: { label: "Ranking-cache compleet", color: "#0f766e", fill: "#ccfbf1" },
  };

  function parseLocalityFromMeta(meta) {
    if (!meta) return null;
    const src = meta.source || {};
    if (src.locality_id != null) return Number(src.locality_id);
    const id = meta.id || "";
    const m = /^cf-l(\d+)-/.exec(id);
    if (m) return Number(m[1]);
    if (id === "nl-limburg") return 27;
    return null;
  }

  async function loadGeo() {
    const url = new URL("data/climbfinder-regions-geo.json", document.baseURI || location.href).href;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Geo-bestand HTTP ${res.status}`);
    return res.json();
  }

  async function loadPublishedByLocality() {
    if (typeof global.FietsKlimImportStatus !== "undefined") {
      return global.FietsKlimImportStatus.loadPublishedByLocality();
    }
    const indexUrl = new URL("data/index.json", document.baseURI || location.href).href;
    const res = await fetch(indexUrl, { cache: "no-store" });
    if (!res.ok) return {};
    const index = await res.json();
    const out = {};
    for (const entry of index.regions || []) {
      const loc =
        entry.locality_id != null
          ? Number(entry.locality_id)
          : parseLocalityFromMeta({ id: entry.id, source: {} });
      if (loc == null) continue;
      out[String(loc)] = {
        datasetId: entry.id,
        title: entry.title,
        count: entry.count ?? 0,
      };
    }
    return out;
  }

  let popularTotalsByLocality = null;

  async function loadPopularTotalsIndex() {
    if (popularTotalsByLocality) return popularTotalsByLocality;
    try {
      const url = new URL(
        "data/climbfinder-region-popular-counts.json",
        document.baseURI || location.href
      ).href;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        popularTotalsByLocality = {};
        return popularTotalsByLocality;
      }
      const data = await res.json();
      popularTotalsByLocality = data.by_locality || {};
    } catch {
      popularTotalsByLocality = {};
    }
    return popularTotalsByLocality;
  }

  function climbfinderPopularTotal(localityId) {
    const row = popularTotalsByLocality?.[String(localityId)];
    const n = row?.popular_count;
    return typeof n === "number" && n >= 0 ? n : null;
  }

  async function loadRankingCount(localityId) {
    try {
      const url = new URL(
        `data/rankings/${localityId}-popular-slugs.json`,
        document.baseURI || location.href
      ).href;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return null;
      const data = await res.json();
      return { count: data.count, pages: data.pages, name: data.name };
    } catch {
      return null;
    }
  }

  function statusForRegion(published, ranking) {
    const pub = published ? published.count : 0;
    if (pub <= 0) return "none";
    const cacheN = ranking?.count ?? 0;
    if (cacheN > 0 && pub >= cacheN) return "cache";
    return "partial";
  }

  function markerIcon(statusKey, selected) {
    const st = STATUS[statusKey] || STATUS.none;
    const ring = selected ? "box-shadow:0 0 0 3px #0f766e;" : "";
    return L.divIcon({
      className: "cf-region-marker-wrap",
      html: `<span class="cf-region-marker" style="background:${st.fill};border:2px solid ${st.color};${ring}"></span>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
  }

  /**
   * @param {object} opts
   * @param {string} opts.mapId
   * @param {string} opts.countrySelectId
   * @param {string} opts.regionSelectId
   * @param {string} [opts.searchId]
   * @param {string} [opts.searchResultsId]
   * @param {string} [opts.legendId]
   * @param {() => void} [opts.onRegionChosen]
   */
  async function init(opts) {
    const mapEl = document.getElementById(opts.mapId);
    if (!mapEl || typeof L === "undefined") {
      throw new Error("Leaflet of kaart-element ontbreekt");
    }

    const countrySel = document.getElementById(opts.countrySelectId);
    const regionSel = document.getElementById(opts.regionSelectId);
    const searchEl = opts.searchId ? document.getElementById(opts.searchId) : null;
    const searchResultsEl = opts.searchResultsId ? document.getElementById(opts.searchResultsId) : null;
    const legendEl = opts.legendId ? document.getElementById(opts.legendId) : null;

    const [geo, publishedMap] = await Promise.all([
      loadGeo(),
      loadPublishedByLocality(),
      loadPopularTotalsIndex(),
    ]);

    let map = null;
    let clusterLayer = null;
    let mapReady = false;
    let markersById = {};
    let rankingCache = {};
    let bootCatalog = null;
    let drawToken = 0;
    let overviewBounds = null;
    let selectedLocalityId = null;
    let mapClickBound = false;

    async function ensureMap() {
      if (mapReady) return;
      map = L.map(mapEl, { scrollWheelZoom: true }).setView([50.5, 5.5], 5);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
        maxZoom: 18,
      }).addTo(map);
      clusterLayer = L.markerClusterGroup({
        maxClusterRadius: 40,
        showCoverageOnHover: false,
        spiderfyOnMaxZoom: true,
      });
      map.addLayer(clusterLayer);
      mapReady = true;
    }

    function bindMapDeselect() {
      if (mapClickBound || !map) return;
      mapClickBound = true;
      map.on("click", () => {
        if (selectedLocalityId == null) return;
        clearSelection();
      });
    }

    function findRegionInCatalog(localityId) {
      if (!bootCatalog) return null;
      for (const block of bootCatalog.countries) {
        for (const r of block.regions) {
          if (Number(r.id) === Number(localityId)) {
            return { ...r, country: block.country, country_iso: r.country_iso || null };
          }
        }
      }
      return null;
    }

    function selectInDropdowns(localityId, goToImportTab = false) {
      const region = findRegionInCatalog(localityId);
      if (!region) return;
      if (countrySel && countrySel.value !== region.country) {
        countrySel.value = region.country;
        countrySel.dispatchEvent(new Event("change", { bubbles: true }));
      }
      requestAnimationFrame(() => {
        if (regionSel) {
          regionSel.value = String(localityId);
          regionSel.dispatchEvent(new Event("change", { bubbles: true }));
        }
        if (goToImportTab) opts.onRegionChosen?.();
      });
    }

    function highlightMarker(localityId) {
      selectedLocalityId = localityId != null && localityId !== "" ? Number(localityId) : null;
      for (const [id, mk] of Object.entries(markersById)) {
        const st = mk._cfStatus || "none";
        mk.setIcon(markerIcon(st, Number(id) === selectedLocalityId));
      }
    }

    function clearSelection() {
      selectedLocalityId = null;
      highlightMarker(null);
      if (regionSel) {
        const empty = regionSel.querySelector('option[value=""]');
        if (empty) {
          regionSel.value = "";
          regionSel.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      map.closePopup();
      if (overviewBounds) {
        map.fitBounds(overviewBounds, { padding: [28, 28], maxZoom: 6 });
      } else {
        map.setView([50.5, 5.5], 5);
      }
    }

    function boundsForCountry(countryName) {
      if (!bootCatalog || !countryName) return null;
      const block = bootCatalog.countries.find((c) => c.country === countryName);
      if (!block) return null;
      const pts = [];
      for (const r of block.regions) {
        const g = geo.regions[String(r.id)];
        if (g) pts.push([g.lat, g.lon]);
      }
      return pts.length ? L.latLngBounds(pts) : null;
    }

    function applySelectionFromDropdown({ openPopup = false, preferCountryView = false } = {}) {
      if (!mapReady) return;
      const id = regionSel?.value;
      if (!id) return;

      selectedLocalityId = Number(id);
      highlightMarker(selectedLocalityId);

      const mk = markersById[id];
      const g = geo.regions[String(id)];
      const countryName = countrySel?.value;

      const afterVisible = () => {
        if (preferCountryView && countryName) {
          const cb = boundsForCountry(countryName);
          if (cb) {
            map.fitBounds(cb, { padding: [36, 36], maxZoom: 8 });
          }
        } else if (g) {
          map.setView([g.lat, g.lon], Math.max(map.getZoom(), 10));
        }
        if (openPopup && mk) mk.openPopup();
      };

      if (mk && clusterLayer?.zoomToShowLayer) {
        clusterLayer.zoomToShowLayer(mk, afterVisible);
      } else {
        afterVisible();
      }
    }

    async function popupHtml(localityId, regionName, countryName) {
      await loadPopularTotalsIndex();
      const cfTotal = climbfinderPopularTotal(localityId);
      const pub = publishedMap[String(localityId)];
      let ranking = rankingCache[localityId];
      if (ranking === undefined) {
        ranking = await loadRankingCount(localityId);
        rankingCache[localityId] = ranking;
      }
      const st = statusForRegion(pub, ranking);
      const stMeta = STATUS[st];
      let lines = [
        `<strong>${regionName}</strong>`,
        `<code>l=${localityId}</code> · ${countryName}`,
        `<span style="color:${stMeta.color}">${stMeta.label}</span>`,
      ];
      if (pub) {
        lines.push(`Dataset <em>${pub.title || pub.datasetId}</em>: ${pub.count} klimmen op FietsKlim-kaart`);
      }
      if (cfTotal != null) {
        lines.push(`Climbfinder Popular: <strong>${cfTotal}</strong> klimmen`);
      }
      if (ranking) {
        lines.push(`Ranking-cache: ${ranking.count} slugs (${ranking.pages} pag.)`);
      } else {
        lines.push('<span style="color:#64748b">Geen ranking-cache lokaal</span>');
      }
      lines.push(
        `<button type="button" class="cf-pick-region" data-l="${localityId}" style="margin-top:0.35rem;padding:0.35rem 0.6rem;border:0;border-radius:4px;background:#0f766e;color:#fff;font:inherit;cursor:pointer">Kies voor import</button>`
      );
      return lines.join("<br/>");
    }

    function attachMarkerHandlers(mk, r, countryName) {
      mk.on("click", (ev) => {
        L.DomEvent.stopPropagation(ev);
        highlightMarker(r.id);
        selectInDropdowns(r.id, false);
        const g = geo.regions[String(r.id)];
        if (g) map.setView([g.lat, g.lon], Math.max(map.getZoom(), 10));
      });
      mk.on("popupopen", async () => {
        const html = await popupHtml(r.id, r.name, countryName);
        mk.setPopupContent(html);
        const popEl = mk.getPopup()?.getElement();
        popEl?.querySelector(".cf-pick-region")?.addEventListener("click", (ev) => {
          L.DomEvent.stopPropagation(ev);
          selectInDropdowns(r.id, true);
          highlightMarker(r.id);
          map.closePopup();
        });
      });
    }

    async function drawAllRegions() {
      const token = ++drawToken;
      await ensureMap();
      bindMapDeselect();
      if (token !== drawToken) return;

      clusterLayer.clearLayers();
      markersById = {};
      if (!bootCatalog) {
        map.setView([50.5, 5.5], 5);
        return;
      }

      const bounds = [];
      for (const block of bootCatalog.countries) {
        for (const r of block.regions) {
          const g = geo.regions[String(r.id)];
          if (!g) continue;
          bounds.push([g.lat, g.lon]);

          const pub = publishedMap[String(r.id)];
          const st = statusForRegion(pub, null);
          const mk = L.marker([g.lat, g.lon], {
            icon: markerIcon(st, Number(r.id) === selectedLocalityId),
          });
          mk._cfStatus = st;
          mk.bindPopup("Laden…");
          attachMarkerHandlers(mk, r, block.country);
          clusterLayer.addLayer(mk);
          markersById[r.id] = mk;
        }
      }

      if (bounds.length) {
        overviewBounds = L.latLngBounds(bounds);
        const dropdownId = regionSel?.value;
        if (!dropdownId && selectedLocalityId == null) {
          map.fitBounds(overviewBounds, { padding: [28, 28], maxZoom: 6 });
        }
      } else {
        overviewBounds = null;
        map.setView([50.5, 5.5], 5);
      }

      if (regionSel?.value) {
        applySelectionFromDropdown({ preferCountryView: false });
      } else if (selectedLocalityId != null) {
        highlightMarker(selectedLocalityId);
        applySelectionFromDropdown({ preferCountryView: false });
      } else if (countrySel?.value) {
        const cb = boundsForCountry(countrySel.value);
        if (cb) map.fitBounds(cb, { padding: [36, 36], maxZoom: 8 });
      }

      requestAnimationFrame(() => map.invalidateSize());
    }

    function findRegionsMatchingQuery(q) {
      const query = q.trim().toLowerCase();
      if (!query || !bootCatalog) return [];
      const idQuery = /^\d+$/.test(query) ? Number(query) : null;
      const matches = [];
      for (const block of bootCatalog.countries) {
        for (const r of block.regions) {
          if (idQuery != null) {
            if (Number(r.id) === idQuery) matches.push({ block, r, score: 100 });
            else if (String(r.id).startsWith(query)) matches.push({ block, r, score: 50 });
            continue;
          }
          const name = r.name.toLowerCase();
          if (name === query) matches.push({ block, r, score: 90 });
          else if (name.startsWith(query)) matches.push({ block, r, score: 70 });
          else if (name.includes(query)) matches.push({ block, r, score: 40 });
        }
      }
      matches.sort((a, b) => b.score - a.score || a.r.name.localeCompare(b.r.name));
      return matches.slice(0, 12);
    }

    function renderSearchResults(matches) {
      if (!searchResultsEl) return;
      if (!matches.length) {
        searchResultsEl.innerHTML = "";
        searchResultsEl.hidden = true;
        return;
      }
      searchResultsEl.hidden = false;
      searchResultsEl.innerHTML = matches
        .map((m) => {
          const total = climbfinderPopularTotal(m.r.id);
          const countBit = total != null ? ` · ~${total} Popular` : "";
          return `<button type="button" class="cf-search-hit" data-l="${m.r.id}" data-country="${m.block.country.replace(/"/g, "&quot;")}">${m.r.name} <span class="muted">(${m.block.country}, l=${m.r.id}${countBit})</span></button>`;
        })
        .join("");
      searchResultsEl.querySelectorAll(".cf-search-hit").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = Number(btn.getAttribute("data-l"));
          const country = btn.getAttribute("data-country");
          const block = bootCatalog.countries.find((c) => c.country === country);
          if (block) applySearchPick(block, block.regions.find((r) => r.id === id));
        });
      });
    }

    async function applySearchPick(block, r) {
      if (!block || !r) return;
      selectInDropdowns(r.id, false);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await drawAllRegions();
      applySelectionFromDropdown({ preferCountryView: false, openPopup: true });
      if (searchResultsEl) {
        searchResultsEl.innerHTML = "";
        searchResultsEl.hidden = true;
      }
    }

    let searchBound = false;

    function bindSearch() {
      if (!searchEl || !bootCatalog || searchBound) return;
      searchBound = true;

      const form = searchEl.closest("form");
      form?.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const matches = findRegionsMatchingQuery(searchEl.value);
        if (matches.length) applySearchPick(matches[0].block, matches[0].r);
      });

      searchEl.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") {
          ev.preventDefault();
          const matches = findRegionsMatchingQuery(searchEl.value);
          if (matches.length) applySearchPick(matches[0].block, matches[0].r);
        }
      });

      searchEl.addEventListener("input", () => {
        const q = searchEl.value.trim();
        if (q.length < 2) {
          renderSearchResults([]);
          return;
        }
        renderSearchResults(findRegionsMatchingQuery(q));
      });
    }

    if (legendEl) {
      legendEl.innerHTML = Object.entries(STATUS)
        .map(
          ([, v]) =>
            `<span class="cf-legend-item"><i style="background:${v.fill};border:2px solid ${v.color}"></i>${v.label}</span>`
        )
        .join("");
    }

    async function pickLocality(localityId, { preferCountryView = false, openPopup = false } = {}) {
      const region = findRegionInCatalog(localityId);
      if (!region) return false;
      await drawAllRegions();
      selectInDropdowns(localityId, false);
      highlightMarker(localityId);
      applySelectionFromDropdown({ preferCountryView, openPopup });
      return true;
    }

    return {
      setCatalog(catalog) {
        bootCatalog = catalog;
        bindSearch();
      },
      pickLocality,
      async onMapTabShown() {
        await drawAllRegions();
        if (regionSel?.value) {
          applySelectionFromDropdown({ preferCountryView: false, openPopup: false });
        }
      },
      refreshCountry() {
        if (!mapReady) return Promise.resolve();
        return drawAllRegions();
      },
      syncFromDropdown() {
        if (!mapReady) return;
        const id = regionSel?.value;
        if (!id) {
          clearSelection();
          return;
        }
        applySelectionFromDropdown({ preferCountryView: false, openPopup: false });
      },
      clearSelection,
      invalidateSize() {
        if (!mapReady) return;
        setTimeout(() => map.invalidateSize(), 120);
      },
    };
  }

  global.ClimbfinderRegionPicker = {
    init,
    parseLocalityFromMeta,
    STATUS,
  };
})(window);
