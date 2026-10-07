/**
 * Importpagina: klim zoeken → kaart, site-status, regio’s (klein↔groot), import-acties.
 */
(function (global) {
  let publishedBySlugPromise = null;
  let slugSmallestPromise = null;
  let map = null;
  let climbMarker = null;
  let regionMarkers = [];
  let sortAsc = true;
  let currentSlug = null;
  let currentLabel = null;
  let currentCountryIso = null;
  let currentCandidates = [];
  let optsRef = null;

  async function loadPublishedBySlug() {
    if (!publishedBySlugPromise) {
      const url = new URL("data/published-climbs-by-slug.json", document.baseURI || location.href).href;
      publishedBySlugPromise = fetch(url, { cache: "no-store" }).then(async (res) => {
        if (!res.ok) return { by_slug: {} };
        return res.json();
      });
    }
    return publishedBySlugPromise;
  }

  async function loadSlugSmallest() {
    if (!slugSmallestPromise) {
      const url = new URL("data/slug-smallest-locality.json", document.baseURI || location.href).href;
      slugSmallestPromise = fetch(url, { cache: "no-store" }).then(async (res) => {
        if (!res.ok) return { by_country: {} };
        return res.json();
      });
    }
    return slugSmallestPromise;
  }

  function popularCount(popularIndex, localityId) {
    const row = popularIndex?.by_locality?.[String(localityId)];
    const n = row?.popular_count;
    return typeof n === "number" && n >= 0 ? n : null;
  }

  function indexEntriesForSlug(slug, searchIndex) {
    const entries = searchIndex?.entries || [];
    return entries.filter((e) => e.slug === slug);
  }

  /**
   * @returns {Promise<object[]>} unified candidate rows
   */
  async function buildCandidates(slug, countryIso, searchIndex) {
    const [published, smallest, popularIndex] = await Promise.all([
      loadPublishedBySlug(),
      loadSlugSmallest(),
      optsRef?.loadPopularCounts?.() ?? Promise.resolve(null),
    ]);
    const site = published.by_slug?.[slug] || null;
    const onSiteLocalities = new Set(
      (site?.site_copies || [])
        .map((c) => c.locality_id)
        .filter((id) => id != null)
        .map(Number)
    );
    const byLoc = new Map();

    for (const e of indexEntriesForSlug(slug, searchIndex)) {
      const id = Number(e.locality_id);
      if (!byLoc.has(id)) {
        byLoc.set(id, {
          locality_id: id,
          region_name: e.region_name,
          country: e.country,
          country_iso: e.country_iso || countryIso,
          in_ranking_cache: true,
        });
      }
    }

    const iso = (countryIso || "").toUpperCase();
    const sm = iso && smallest.by_country?.[iso]?.[slug];
    if (sm?.locality_id != null) {
      const id = Number(sm.locality_id);
      const row = byLoc.get(id) || {
        locality_id: id,
        region_name: sm.region_name,
        country: iso,
        country_iso: iso,
        in_ranking_cache: false,
      };
      row.smallest_suggested = true;
      row.region_name = row.region_name || sm.region_name;
      row.popular_count = sm.popular_count ?? row.popular_count;
      byLoc.set(id, row);
    }

    for (const copy of site?.site_copies || []) {
      if (copy.locality_id == null) continue;
      const id = Number(copy.locality_id);
      const row = byLoc.get(id) || {
        locality_id: id,
        region_name: copy.title || `l=${id}`,
        country: iso || "?",
        country_iso: iso,
        in_ranking_cache: false,
      };
      row.on_site = true;
      row.site_title = copy.title;
      row.climb_region = copy.climb_region;
      byLoc.set(id, row);
    }

    const publishedByLoc = optsRef?.getPublishedByLocality?.() || {};
    const out = [];
    for (const row of byLoc.values()) {
      const pc =
        row.popular_count ??
        popularCount(popularIndex, row.locality_id) ??
        (row.smallest_suggested ? sm?.popular_count : null);
      row.popular_count = pc;
      row.on_site = row.on_site || onSiteLocalities.has(row.locality_id);
      const pub = publishedByLoc[String(row.locality_id)];
      row.locality_published_count = pub?.count ?? 0;
      if (typeof FietsKlimImportStatus !== "undefined") {
        row.import_status = FietsKlimImportStatus.statusKey(
          row.locality_published_count,
          pc
        );
      } else {
        row.import_status = row.locality_published_count > 0 ? "partial" : "none";
      }
      out.push(row);
    }

    out.sort((a, b) => {
      const pa = a.popular_count ?? 1e9;
      const pb = b.popular_count ?? 1e9;
      if (pa !== pb) return sortAsc ? pa - pb : pb - pa;
      return String(a.region_name).localeCompare(String(b.region_name), "nl");
    });
    return { site, candidates: out };
  }

  function statusBadge(key) {
    if (typeof FietsKlimImportStatus !== "undefined") {
      return FietsKlimImportStatus.STATUS_LABEL[key]?.short || "○";
    }
    return key === "full" ? "●" : key === "partial" ? "◐" : "○";
  }

  function renderSummary(site, slug, label) {
    const el = document.getElementById("climbLookupSummary");
    if (!el) return;
    if (site?.on_site) {
      const copies = site.site_copies || [];
      const regions = [...new Set(copies.map((c) => c.climb_region || c.title).filter(Boolean))];
      el.innerHTML =
        `<p style="margin:0.35rem 0 0"><strong>${label}</strong> <code>${slug}</code> — ` +
        `<span style="color:#047857">✓ al op de site</span> (${copies.length} dataset${copies.length === 1 ? "" : "s"})` +
        (regions.length
          ? `<br><span class="hint">Regiolabel op klim: ${regions.map((r) => `<em>${r}</em>`).join(" · ")}</span>`
          : "") +
        `</p>`;
    } else {
      el.innerHTML =
        `<p style="margin:0.35rem 0 0"><strong>${label}</strong> <code>${slug}</code> — ` +
        `<span style="color:#b45309">nog niet op de site</span> (wel in ranking-cache of Climbfinder-regio’s hieronder)</p>`;
    }
  }

  function fillRegionPickSelect(candidates, site) {
    const sel = document.getElementById("climbLookupRegionPick");
    if (!sel) return;
    sel.innerHTML = "";
    if (!candidates.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "— geen regio gevonden in cache —";
      sel.appendChild(o);
      return;
    }
    let defaultId = null;
    if (site?.on_site) {
      defaultId = candidates.find((c) => c.on_site)?.locality_id;
    }
    if (defaultId == null) {
      defaultId = candidates.find((c) => c.smallest_suggested)?.locality_id ?? candidates[0].locality_id;
    }
    for (const c of candidates) {
      const o = document.createElement("option");
      o.value = String(c.locality_id);
      const pc = c.popular_count != null ? ` · ~${c.popular_count} Popular` : "";
      const siteTag = c.on_site ? " · klim op site" : "";
      o.textContent = `${c.region_name} (l=${c.locality_id}${pc})${siteTag}`;
      if (c.locality_id === defaultId) o.selected = true;
      sel.appendChild(o);
    }
  }

  function renderRegionList(candidates) {
    const list = document.getElementById("climbLookupRegionList");
    if (!list) return;
    list.innerHTML = candidates
      .map((c) => {
        const badge = statusBadge(c.import_status);
        const pc = c.popular_count != null ? `${c.popular_count} Popular` : "Popular ?";
        const siteLine = c.on_site
          ? `<strong style="color:#047857">deze klim in dataset</strong>${c.climb_region ? ` · label <em>${c.climb_region}</em>` : ""}`
          : `<span style="color:#64748b">klim niet in dit bundle</span>`;
        const cache = c.in_ranking_cache
          ? "slug in ranking-cache"
          : "niet in lokale ranking-cache";
        const sm = c.smallest_suggested ? ' · <span style="color:#0f766e">kleinste regio (heuristiek)</span>' : "";
        return `<li><strong>${c.region_name}</strong> <code>l=${c.locality_id}</code> · ${pc} · ${badge} regio-import ${c.locality_published_count}${pc.includes("?") ? "" : `/${c.popular_count}`} · ${siteLine} · ${cache}${sm}</li>`;
      })
      .join("");
  }

  function ensureMap() {
    const el = document.getElementById("climbLookupMap");
    if (!el || typeof L === "undefined") return false;
    if (!map) {
      map = L.map(el, { scrollWheelZoom: true });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; OSM',
        maxZoom: 18,
      }).addTo(map);
    }
    return true;
  }

  async function drawMap(site, candidates) {
    if (!ensureMap()) return;
    if (climbMarker) {
      map.removeLayer(climbMarker);
      climbMarker = null;
    }
    for (const m of regionMarkers) map.removeLayer(m);
    regionMarkers = [];

    const geoUrl = new URL("data/climbfinder-regions-geo.json", document.baseURI || location.href).href;
    let geo = {};
    try {
      const res = await fetch(geoUrl, { cache: "no-store" });
      if (res.ok) geo = (await res.json()).regions || {};
    } catch {
      /* ignore */
    }

    const bounds = [];
    for (const c of candidates) {
      const g = geo[String(c.locality_id)];
      if (!g) continue;
      const color = c.on_site ? "#047857" : c.smallest_suggested ? "#0f766e" : "#94a3b8";
      const mk = L.circleMarker([g.lat, g.lon], {
        radius: c.on_site ? 9 : 7,
        color,
        fillColor: color,
        fillOpacity: 0.85,
        weight: 2,
      }).bindTooltip(`${c.region_name} (l=${c.locality_id})`, { direction: "top" });
      mk.addTo(map);
      regionMarkers.push(mk);
      bounds.push([g.lat, g.lon]);
    }

    if (site?.lat != null && site?.lng != null) {
      climbMarker = L.marker([site.lat, site.lng], {
        title: currentLabel || currentSlug,
      }).bindPopup(`<strong>${currentLabel || currentSlug}</strong><br>Startpunt (geïmporteerd)`);
      climbMarker.addTo(map);
      bounds.push([site.lat, site.lng]);
    }

    if (bounds.length) {
      map.fitBounds(bounds, { padding: [36, 36], maxZoom: 11 });
    } else {
      map.setView([50.5, 5.5], 5);
    }
    setTimeout(() => map.invalidateSize(), 80);
  }

  function bindPanelActions() {
    const sortBtn = document.getElementById("climbLookupSortBtn");
    if (sortBtn && !sortBtn.dataset.bound) {
      sortBtn.dataset.bound = "1";
      sortBtn.addEventListener("click", async () => {
        sortAsc = !sortAsc;
        sortBtn.textContent = sortAsc ? "Sorteer: klein → groot (Popular)" : "Sorteer: groot → klein (Popular)";
        if (!currentSlug) return;
        const idx = await optsRef.ensureSearchIndex();
        const { site, candidates } = await buildCandidates(currentSlug, currentCountryIso, idx);
        currentCandidates = candidates;
        renderRegionList(candidates);
        fillRegionPickSelect(candidates, site);
        await drawMap(site, candidates);
      });
    }

    const mapTabBtn = document.getElementById("climbLookupOpenMapTabBtn");
    if (mapTabBtn && !mapTabBtn.dataset.bound) {
      mapTabBtn.dataset.bound = "1";
      mapTabBtn.addEventListener("click", async () => {
        const sel = document.getElementById("climbLookupRegionPick");
        const id = sel?.value ? Number(sel.value) : null;
        if (id != null) await optsRef.pickLocalityOnMainMap?.(id);
      });
    }

    const importBtn = document.getElementById("climbLookupImportBtn");
    if (importBtn && !importBtn.dataset.bound) {
      importBtn.dataset.bound = "1";
      importBtn.addEventListener("click", async () => {
        const sel = document.getElementById("climbLookupRegionPick");
        const id = sel?.value ? Number(sel.value) : null;
        if (id == null) {
          optsRef.log?.("Kies eerst een regio voor import.");
          return;
        }
        await optsRef.startRegionImport?.(id);
      });
    }

    const manualBtn = document.getElementById("climbLookupManualBtn");
    if (manualBtn && !manualBtn.dataset.bound) {
      manualBtn.dataset.bound = "1";
      manualBtn.addEventListener("click", () => {
        if (!currentSlug) return;
        optsRef.openManualImport?.(currentSlug, currentLabel);
      });
    }
  }

  async function showFromSearchEntry(entry, searchIndex) {
    optsRef = optsRef || global.__climbLookupOpts;
    if (!optsRef) return;
    bindPanelActions();

    currentSlug = entry.slug;
    currentLabel = entry.label || entry.slug;
    currentCountryIso = entry.country_iso || entry.country || null;

    const panel = document.getElementById("climbLookupPanel");
    if (panel) panel.hidden = false;

    const sortBtn = document.getElementById("climbLookupSortBtn");
    if (sortBtn) sortBtn.textContent = sortAsc ? "Sorteer: klein → groot (Popular)" : "Sorteer: groot → klein (Popular)";

    const { site, candidates } = await buildCandidates(currentSlug, currentCountryIso, searchIndex);
    currentCandidates = candidates;
    renderSummary(site, currentSlug, currentLabel);
    renderRegionList(candidates);
    fillRegionPickSelect(candidates, site);
    await drawMap(site, candidates);

    if (!candidates.length && !site?.on_site) {
      const sum = document.getElementById("climbLookupSummary");
      if (sum) {
        sum.innerHTML +=
          `<br><span class="hint">Niet in lokale ranking-cache. Probeer handmatige import (browser) of kies een regio op de kaart-tabs.</span>`;
      }
    }
  }

  function init(opts) {
    global.__climbLookupOpts = opts;
    optsRef = opts;
    bindPanelActions();
  }

  global.FietsKlimClimbLookup = {
    init,
    showFromSearchEntry,
    buildCandidates,
  };
})(typeof window !== "undefined" ? window : globalThis);
