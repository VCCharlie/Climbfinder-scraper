/** Logboek-pagina: alle logboek-klimmen, filters, statistieken, Strava-ontkoppelen. */
(function (global) {
  const log = global.FietsKlimClimbLog;
  const FILTER_STORAGE_KEY = "fietsklim-logbook-filters-v1";

  const COUNTRY_LABELS = {
    BE: "België",
    NL: "Nederland",
    FR: "Frankrijk",
    DE: "Duitsland",
    LU: "Luxemburg",
    ES: "Spanje",
    IT: "Italië",
    CH: "Zwitserland",
    AT: "Oostenrijk",
    GB: "Verenigd Koninkrijk",
  };

  let indexRegions = [];
  const datasetCountry = new Map();
  const bundleCache = new Map();
  /** @type {Array<{ row: object, country: string, year: number|null, category: string, elevation: number }>} */
  let enrichedCache = [];

  const filters = {
    country: "",
    yearFrom: "",
    yearTo: "",
    category: "",
    elevMin: "",
    elevMax: "",
    done: "all",
  };

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function countryLabel(code) {
    if (!code) return "Onbekend";
    return COUNTRY_LABELS[code] || code;
  }

  function readFiltersFromForm() {
    filters.country = $("logbookCountryFilter")?.value || "";
    filters.yearFrom = String($("logbookYearFrom")?.value ?? "").trim();
    filters.yearTo = String($("logbookYearTo")?.value ?? "").trim();
    filters.category = $("logbookCategoryFilter")?.value || "";
    filters.elevMin = String($("logbookElevMin")?.value ?? "").trim();
    filters.elevMax = String($("logbookElevMax")?.value ?? "").trim();
    filters.done = $("logbookDoneFilter")?.value || "all";
    try {
      sessionStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
    } catch {
      /* ignore */
    }
  }

  function applyFiltersToForm() {
    if ($("logbookCountryFilter")) $("logbookCountryFilter").value = filters.country;
    if ($("logbookYearFrom")) $("logbookYearFrom").value = filters.yearFrom;
    if ($("logbookYearTo")) $("logbookYearTo").value = filters.yearTo;
    if ($("logbookCategoryFilter")) $("logbookCategoryFilter").value = filters.category;
    if ($("logbookElevMin")) $("logbookElevMin").value = filters.elevMin;
    if ($("logbookElevMax")) $("logbookElevMax").value = filters.elevMax;
    if ($("logbookDoneFilter")) $("logbookDoneFilter").value = filters.done;
  }

  function loadFiltersFromStorage() {
    try {
      const raw = sessionStorage.getItem(FILTER_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      Object.assign(filters, saved);
    } catch {
      /* ignore */
    }
  }

  function resetFilters() {
    filters.country = "";
    filters.yearFrom = "";
    filters.yearTo = "";
    filters.category = "";
    filters.elevMin = "";
    filters.elevMax = "";
    filters.done = "all";
    applyFiltersToForm();
    try {
      sessionStorage.removeItem(FILTER_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  async function loadIndex() {
    if (indexRegions.length) return indexRegions;
    const res = await fetch("data/index.json");
    const data = await res.json();
    indexRegions = data.regions || [];
    for (const r of indexRegions) {
      const id = r.id || log?.datasetIdFromRegionUrl?.(r.url);
      if (id) datasetCountry.set(id, r.country || "");
    }
    return indexRegions;
  }

  async function loadBundle(datasetId) {
    if (bundleCache.has(datasetId)) return bundleCache.get(datasetId);
    const url = `data/${datasetId}.json`;
    try {
      const bundle = await fetch(url).then((r) => {
        if (!r.ok) throw new Error(r.statusText);
        return r.json();
      });
      bundleCache.set(datasetId, bundle);
      return bundle;
    } catch (e) {
      console.warn("Dataset laden", datasetId, e.message);
      bundleCache.set(datasetId, null);
      return null;
    }
  }

  async function climbMeta(datasetId, climbId) {
    const bundle = await loadBundle(datasetId);
    if (!bundle?.climbs) return null;
    return bundle.climbs.find((c) => String(c.id) === String(climbId)) || null;
  }

  /** Strava-logomark (twee oranje strepen), niet het woordmerk. */
  const STRAVA_MARK_SVG =
    '<svg class="logbook-strava-mark-svg" viewBox="0 0 384 512" width="11" height="14" aria-hidden="true"><path fill="#fc4c02" d="M158.4 0L7 292.3h48.7L158.4 75.6l71.1 130.3h63.4L158.4 0zm87.2 216.7l-48.7 89.1L292.7 512h48.7L245.6 216.7h-0z"/></svg>';

  function logRows() {
    if (!log?.isReady?.() || !log.listEntries) return [];
    return log.listEntries().sort((a, b) => {
      const na = (a.stravaClimbName || a.climbId || "").toLowerCase();
      const nb = (b.stravaClimbName || b.climbId || "").toLowerCase();
      return na.localeCompare(nb, "nl");
    });
  }

  function stravaMarkElement() {
    const span = document.createElement("span");
    span.className = "logbook-strava-mark";
    span.title = "Gekoppeld via Strava";
    span.setAttribute("aria-label", "Strava");
    span.innerHTML = STRAVA_MARK_SVG;
    return span;
  }

  function rowCountry(row) {
    return datasetCountry.get(row.datasetId) || "";
  }

  function climbCategory(climb) {
    return (
      climb?.climbfinder?.category ||
      climb?.classification ||
      climb?.stats?.classification ||
      ""
    );
  }

  async function rebuildEnrichedCache() {
    const rows = logRows();
    const out = [];
    for (const row of rows) {
      const climb = await climbMeta(row.datasetId, row.climbId);
      const elev = Number(climb?.stats?.elevation_gain_m);
      const displayName = row.stravaClimbName || climb?.name || row.climbId || "Klim";
      out.push({
        row,
        displayName,
        country: rowCountry(row),
        year: log?.logbookEntryYear?.(row) ?? null,
        category: String(climbCategory(climb) || ""),
        elevation: Number.isFinite(elev) ? elev : 0,
      });
    }
    out.sort((a, b) => a.displayName.localeCompare(b.displayName, "nl"));
    enrichedCache = out;
    return out;
  }

  function passesFilters(item) {
    if (filters.country && item.country !== filters.country) return false;

    const yFrom = filters.yearFrom ? Number(filters.yearFrom) : null;
    const yTo = filters.yearTo ? Number(filters.yearTo) : null;
    if ((yFrom != null || yTo != null) && item.year == null) return false;
    if (yFrom != null && item.year != null && item.year < yFrom) return false;
    if (yTo != null && item.year != null && item.year > yTo) return false;

    if (filters.category && item.category !== filters.category) return false;

    const eMin = filters.elevMin ? Number(filters.elevMin) : null;
    const eMax = filters.elevMax ? Number(filters.elevMax) : null;
    if (eMin != null && item.elevation < eMin) return false;
    if (eMax != null && item.elevation > eMax) return false;

    const done = Boolean(item.row.done);
    const wish = Boolean(item.row.wishlist);
    if (filters.done === "done" && !done) return false;
    if (filters.done === "wishlist" && !wish) return false;
    if (filters.done === "strava" && !item.row.stravaActivityId) return false;

    return true;
  }

  function filteredEnriched() {
    return enrichedCache.filter(passesFilters);
  }

  function fillFilterOptions() {
    const countrySel = $("logbookCountryFilter");
    const catSel = $("logbookCategoryFilter");
    const codes = new Set();
    const cats = new Set();
    for (const item of enrichedCache) {
      if (item.country) codes.add(item.country);
      if (item.category) cats.add(item.category);
    }
    if (countrySel) {
      const sorted = [...codes].sort();
      countrySel.innerHTML =
        `<option value="">Alle landen</option>` +
        sorted.map((c) => `<option value="${c}">${escapeHtml(countryLabel(c))}</option>`).join("");
      countrySel.value = filters.country;
    }
    if (catSel) {
      const sorted = [...cats].sort((a, b) => String(a).localeCompare(String(b), "nl"));
      catSel.innerHTML =
        `<option value="">Alle categorieën</option>` +
        sorted.map((c) => `<option value="${c}">Cat. ${escapeHtml(c)}</option>`).join("");
      catSel.value = filters.category;
    }
  }

  function bindFilterUi() {
    $("logbookFiltersApply")?.addEventListener("click", () => {
      readFiltersFromForm();
      void renderAll();
    });
    $("logbookFiltersReset")?.addEventListener("click", () => {
      resetFilters();
      void renderAll();
    });
    const autoIds = [
      "logbookCountryFilter",
      "logbookCategoryFilter",
      "logbookDoneFilter",
    ];
    for (const id of autoIds) {
      $(id)?.addEventListener("change", () => {
        readFiltersFromForm();
        void renderAll();
      });
    }
  }

  function renderListItem(row, displayName) {
    const li = document.createElement("li");
    const climbLabel = displayName || row.stravaClimbName || row.climbId || "Klim";
    const actId = row.stravaActivityId;
    const actLabel = row.stravaActivityName || (actId ? `Rit ${actId}` : "Strava-rit");
    const cc = rowCountry(row);
    const ds = row.datasetId
      ? `<span class="strava-match-dataset">${escapeHtml(row.datasetId)}</span>${cc ? ` · ${escapeHtml(countryLabel(cc))}` : ""} · `
      : "";

    const strong = document.createElement("strong");
    if (row.datasetId && row.climbId && log?.databaseClimbUrl) {
      const climbLink = document.createElement("a");
      climbLink.href = log.databaseClimbUrl(row.datasetId, row.climbId, { back: "logbook" });
      climbLink.textContent = climbLabel;
      climbLink.className = "strava-match-climb-link";
      climbLink.addEventListener("click", () => log.rememberNavBack?.("logbook"));
      strong.appendChild(climbLink);
    } else {
      strong.textContent = climbLabel;
    }
    if (row.stravaActivityId) {
      strong.appendChild(stravaMarkElement());
    }

    const statusBits = [];
    if (row.done) statusBits.push("Geklommen");
    if (row.wishlist) statusBits.push("Bucket list");
    if (statusBits.length) {
      const st = document.createElement("span");
      st.className = "logbook-row-status";
      st.textContent = ` (${statusBits.join(" · ")})`;
      strong.appendChild(st);
    }

    const wrap = document.createElement("span");
    wrap.innerHTML = ds;
    li.appendChild(wrap);
    li.appendChild(strong);

    if (row.stravaActivityId) {
      const stravaLink = document.createElement("a");
      stravaLink.textContent = actLabel;
      if (log?.applyStravaActivityAnchor && actId) {
        log.applyStravaActivityAnchor(stravaLink, actId);
      } else if (actId) {
        stravaLink.href = `https://www.strava.com/activities/${actId}`;
        stravaLink.target = "_blank";
        stravaLink.rel = "noopener noreferrer";
      }
      li.appendChild(document.createTextNode(" → "));
      li.appendChild(stravaLink);

      const rideDate = log?.formatStravaRideDate?.(row);
      if (rideDate) {
        const dateSpan = document.createElement("span");
        dateSpan.className = "logbook-ride-date";
        dateSpan.textContent = rideDate;
        li.appendChild(dateSpan);
      }

      const unlink = document.createElement("button");
      unlink.type = "button";
      unlink.className = "logbook-unlink-btn";
      unlink.textContent = "Ontkoppel";
      unlink.title = "Strava-koppeling verwijderen; bij Strava-sync ook gedaan uit";
      unlink.addEventListener("click", () => {
        const ok = global.confirm(
          `Strava-koppeling verwijderen voor “${climbLabel}”?\n\nAls deze klim alleen via Strava als gedaan stond, wordt het vinkje ook uitgezet.`
        );
        if (!ok) return;
        void log.clearStravaLink(row.datasetId, row.climbId).then(() => void refresh());
      });
      li.appendChild(unlink);
    }

    return li;
  }

  async function renderList() {
    const ul = $("logbookStravaList");
    const empty = $("logbookListEmpty");
    const summary = $("logbookListSummary");
    if (!ul) return;

    const items = filteredEnriched();
    ul.innerHTML = "";
    if (empty) empty.hidden = items.length > 0 || logRows().length > 0;
    if (logRows().length === 0 && empty) empty.hidden = false;

    if (summary) {
      const total = logRows().length;
      summary.textContent =
        total === 0
          ? "Nog geen klimmen in je logboek (gedaan of bucket list)."
          : `${items.length} van ${total} klim(men) binnen je filters`;
    }
    for (const { row, displayName } of items) {
      ul.appendChild(renderListItem(row, displayName));
    }
  }

  async function renderStats() {
    const summaryEl = $("logbookStatsSummary");
    const grid = $("logbookStatsGrid");
    const details = $("logbookStatsDetails");
    const breakdown = $("logbookStatsBreakdown");
    const items = filteredEnriched().filter((i) => i.row.done);
    if (!summaryEl) return;

    if (!items.length) {
      summaryEl.textContent =
        filteredEnriched().length === 0
          ? "Geen rijen binnen de huidige filters."
          : "Geen geklommen klimmen binnen de huidige filters (pas status-filter aan).";
      if (grid) grid.hidden = true;
      if (details) details.hidden = true;
      return;
    }

    const byCountry = new Map();
    const byYear = new Map();
    const byCategory = new Map();
    let totalElev = 0;

    for (const item of items) {
      const row = item.row;
      const cc = item.country || "?";
      byCountry.set(cc, (byCountry.get(cc) || 0) + 1);

      const year = item.year ?? log?.stravaRideYear?.(row) ?? new Date().getFullYear();
      byYear.set(year, (byYear.get(year) || 0) + 1);

      const cat = item.category || "?";
      byCategory.set(cat, (byCategory.get(cat) || 0) + 1);
      totalElev += item.elevation;
    }

    summaryEl.textContent = `Statistieken over ${items.length} geklommen klim(men) binnen je filters. Jaar = Strava-ritdatum.`;

    if (grid) {
      grid.hidden = false;
      grid.innerHTML = `
        <div class="logbook-stat-card"><strong>${items.length}</strong><span>geklommen</span></div>
        <div class="logbook-stat-card"><strong>${byCountry.size}</strong><span>landen</span></div>
        <div class="logbook-stat-card"><strong>${Math.round(totalElev)}</strong><span>hoogtemeters (som)</span></div>
        <div class="logbook-stat-card"><strong>${byCategory.size}</strong><span>categorieën</span></div>`;
    }

    if (details && breakdown) {
      details.hidden = false;
      const countryLines = [...byCountry.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([c, n]) => `<li>${escapeHtml(countryLabel(c))}: ${n}</li>`)
        .join("");
      const yearLines = [...byYear.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([y, n]) => `<li>${y}: ${n}</li>`)
        .join("");
      const catLines = [...byCategory.entries()]
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]), "nl"))
        .map(([c, n]) => `<li>Cat. ${escapeHtml(c)}: ${n}</li>`)
        .join("");
      breakdown.innerHTML = `
        <h3>Per land</h3><ul>${countryLines}</ul>
        <h3>Per jaar (Strava-rit)</h3><ul>${yearLines}</ul>
        <h3>Per categorie</h3><ul>${catLines}</ul>`;
    }
  }

  async function renderAll() {
    await Promise.all([renderList(), renderStats()]);
  }

  async function refresh() {
    if (!log?.isReady?.()) return;
    await loadIndex();
    await rebuildEnrichedCache();
    fillFilterOptions();
    await renderAll();
  }

  async function boot() {
    if (!log) return;
    loadFiltersFromStorage();
    applyFiltersToForm();
    bindFilterUi();
    try {
      await log.init();
    } catch (e) {
      console.warn(e);
    }
    await refresh();
  }

  function focusFromHash() {
    const hash = (global.location.hash || "").replace("#", "");
    if (hash === "stravaLinksSection") {
      $("stravaLinksSection")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    }
  }

  global.addEventListener("fietsklim-climb-log-changed", () => {
    void refresh();
  });
  global.addEventListener("fietsklim-authenticated", () => {
    void boot();
  });
  global.addEventListener("hashchange", focusFromHash);

  if (global.__FIETSKLIM_AUTH_READY) {
    void boot().then(focusFromHash);
  } else {
    document.addEventListener("fietsklim-authenticated", () => void boot().then(focusFromHash), {
      once: true,
    });
  }
})(window);
