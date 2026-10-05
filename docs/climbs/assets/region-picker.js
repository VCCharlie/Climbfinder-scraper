/**
 * Climbfinder regio op kaart — koppel aan import.html (countrySelect / regionSelect).
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
    const indexUrl = new URL("data/index.json", document.baseURI || location.href).href;
    const res = await fetch(indexUrl, { cache: "no-store" });
    if (!res.ok) return {};
    const index = await res.json();
    const out = {};
    for (const entry of index.regions || []) {
      try {
        const bundleUrl = new URL(entry.url, indexUrl).href;
        const br = await fetch(bundleUrl, { cache: "no-store" });
        if (!br.ok) continue;
        const bundle = await br.json();
        const loc = parseLocalityFromMeta(bundle.meta);
        if (loc == null) continue;
        out[String(loc)] = {
          datasetId: entry.id,
          title: entry.title || bundle.meta?.title,
          count: entry.count ?? bundle.meta?.count ?? bundle.climbs?.length ?? 0,
          updated_at: bundle.meta?.updated_at,
        };
      } catch {
        /* skip */
      }
    }
    return out;
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

    const [geo, publishedMap] = await Promise.all([loadGeo(), loadPublishedByLocality()]);

    let map = null;
    let layer = null;
    let mapReady = false;
    let markersById = {};
    let rankingCache = {};
    let bootCatalog = null;
    let drawToken = 0;

    async function ensureMap() {
      if (mapReady) return;
      map = L.map(mapEl, { scrollWheelZoom: true }).setView([50.5, 5.5], 5);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
        maxZoom: 18,
      }).addTo(map);
      layer = L.layerGroup().addTo(map);
      mapReady = true;
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
      for (const [id, mk] of Object.entries(markersById)) {
        const st = mk._cfStatus || "none";
        mk.setIcon(markerIcon(st, Number(id) === Number(localityId)));
      }
    }

    async function popupHtml(localityId, regionName, countryName) {
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
        lines.push(`Dataset <em>${pub.title || pub.datasetId}</em>: ${pub.count} klimmen`);
      }
      if (ranking) {
        lines.push(`Ranking-cache: ${ranking.count} slugs (${ranking.pages} pag.)`);
        if (Number(localityId) === 27) {
          lines.push("Climbfinder toont ~688 klimmen — gebruik <code>pages=all</code>");
        }
      } else {
        lines.push('<span style="color:#64748b">Geen ranking-cache lokaal</span>');
      }
      lines.push(
        `<button type="button" class="cf-pick-region" data-l="${localityId}" style="margin-top:0.35rem;padding:0.35rem 0.6rem;border:0;border-radius:4px;background:#0f766e;color:#fff;font:inherit;cursor:pointer">Kies voor import</button>`
      );
      return lines.join("<br/>");
    }

    async function drawForCountry(countryName) {
      const token = ++drawToken;
      await ensureMap();
      if (token !== drawToken) return;

      layer.clearLayers();
      markersById = {};
      if (!bootCatalog || !countryName) {
        map.setView([50.5, 5.5], 4);
        return;
      }
      const block = bootCatalog.countries.find((c) => c.country === countryName);
      if (!block) return;

      await Promise.all(
        block.regions.map(async (r) => {
          if (rankingCache[r.id] !== undefined) return;
          rankingCache[r.id] = await loadRankingCount(r.id);
        })
      );
      if (token !== drawToken) return;

      const bounds = [];
      const iso = block.regions[0]?.country_iso || geo.regions[String(block.regions[0]?.id)]?.country_iso;
      const countryCentre = iso && geo.countries?.[iso];
      if (countryCentre) {
        map.setView([countryCentre.lat, countryCentre.lon], countryCentre.zoom || 7);
      }

      for (const r of block.regions) {
        const g = geo.regions[String(r.id)];
        if (!g) continue;
        const lat = g.lat;
        const lon = g.lon;
        bounds.push([lat, lon]);

        const pub = publishedMap[String(r.id)];
        const ranking = rankingCache[r.id] ?? null;
        const st = statusForRegion(pub, ranking);
        const mk = L.marker([lat, lon], { icon: markerIcon(st, false) });
        mk._cfStatus = st;
        mk.bindPopup("Laden…");
        mk.on("click", () => highlightMarker(r.id));
        mk.on("popupopen", async () => {
          const html = await popupHtml(r.id, r.name, countryName);
          mk.setPopupContent(html);
          const popEl = mk.getPopup()?.getElement();
          popEl?.querySelector(".cf-pick-region")?.addEventListener("click", () => {
            selectInDropdowns(r.id, true);
            highlightMarker(r.id);
            map.closePopup();
          });
        });
        mk.addTo(layer);
        markersById[r.id] = mk;
      }

      if (bounds.length > 1) {
        map.fitBounds(bounds, { padding: [36, 36], maxZoom: 10 });
      } else if (bounds.length === 1) {
        map.setView(bounds[0], 9);
      }

      const sel = regionSel?.value;
      if (sel) highlightMarker(sel);

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
        .map(
          (m) =>
            `<button type="button" class="cf-search-hit" data-l="${m.r.id}" data-country="${m.block.country.replace(/"/g, "&quot;")}">${m.r.name} <span class="muted">(${m.block.country}, l=${m.r.id})</span></button>`
        )
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
      await ensureMap();
      if (countrySel && countrySel.value !== block.country) {
        countrySel.value = block.country;
        countrySel.dispatchEvent(new Event("change", { bubbles: true }));
        await drawForCountry(block.country);
      } else {
        await drawForCountry(block.country);
      }
      selectInDropdowns(r.id, false);
      highlightMarker(r.id);
      const g = geo.regions[String(r.id)];
      if (g) map.setView([g.lat, g.lon], 11);
      markersById[r.id]?.openPopup();
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

    return {
      setCatalog(catalog) {
        bootCatalog = catalog;
        bindSearch();
      },
      async onMapTabShown() {
        await drawForCountry(countrySel?.value);
      },
      refreshCountry() {
        if (!mapReady) return Promise.resolve();
        return drawForCountry(countrySel?.value);
      },
      syncFromDropdown() {
        if (!mapReady) return;
        const id = regionSel?.value;
        if (!id) return;
        highlightMarker(id);
        const g = geo.regions[id];
        if (g) map.setView([g.lat, g.lon], Math.max(map.getZoom(), 10));
      },
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
