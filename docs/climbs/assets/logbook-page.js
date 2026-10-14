/** Logboek-pagina: alle logboek-klimmen, filters, statistieken, Strava-ontkoppelen. */
(function (global) {
  const log = global.FietsKlimClimbLog;
  const FILTER_STORAGE_KEY = "fietsklim-logbook-filters-v1";
  const TABLE_SEARCH_KEY = "fietsklim-logbook-table-search-v1";

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
  const datasetRegionLabel = new Map();
  const bundleCache = new Map();
  /** @type {Array<object>} */
  let enrichedCache = [];

  let tableSearchQuery = "";
  let tableSortKey = "name";
  let tableSortDir = "asc";
  let tableSearchTimer = null;

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

  function formatNlInteger(n) {
    if (!Number.isFinite(n)) return "0";
    return Math.round(n).toLocaleString("nl-NL");
  }

  /** Interne sleutel voor filter/statistiek: HC, 1–5, of __uncat__ */
  function normalizeCategoryFromClimb(climb) {
    const raw =
      climb?.climbfinder?.category ??
      climb?.classification ??
      climb?.stats?.classification;
    if (raw === undefined || raw === null || raw === "") return "__uncat__";
    const u = String(raw).trim().toUpperCase();
    if (u === "HC" || u === "H.C." || u === "HORS CATEGORIE") return "HC";
    const num = parseInt(u, 10);
    if (Number.isFinite(num) && num >= 1 && num <= 5) return String(num);
    if (u === "?" || u === "UNKNOWN" || u === "—" || u === "-") return "__uncat__";
    return "__uncat__";
  }

  function categoryDisplayLabel(key) {
    if (key === "__uncat__") return "ongecategoriseerd";
    if (key === "HC") return "Cat. HC";
    return `Cat. ${key}`;
  }

  function categorySortRank(key) {
    if (key === "HC") return 0;
    if (key === "__uncat__") return 100;
    const num = parseInt(key, 10);
    if (Number.isFinite(num) && num >= 1 && num <= 5) return num;
    return 99;
  }

  function compareCategoryKeys(a, b) {
    return categorySortRank(a) - categorySortRank(b);
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
    tableSearchQuery = "";
    const searchEl = $("logbookTableSearch");
    if (searchEl) searchEl.value = "";
    try {
      sessionStorage.removeItem(FILTER_STORAGE_KEY);
      sessionStorage.removeItem(TABLE_SEARCH_KEY);
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
      if (!id) continue;
      datasetCountry.set(id, r.country || "");
      datasetRegionLabel.set(id, r.displayTitle || r.title || id);
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

  function stravaMarkSvgHtml() {
    const brand = global.FietsKlimStravaBrand;
    if (brand?.stravaMarkSvg) return brand.stravaMarkSvg({ width: 14, height: 14 });
    return '<img src="assets/strava-logomark.svg" alt="" class="logbook-strava-mark-svg" width="14" height="14" />';
  }

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
    span.innerHTML = stravaMarkSvgHtml();
    return span;
  }

  function rowCountry(row) {
    return datasetCountry.get(row.datasetId) || "";
  }

  function rowRegionLabel(row) {
    return datasetRegionLabel.get(row.datasetId) || row.datasetId || "";
  }

  function rowStatusLabel(row) {
    const bits = [];
    if (row.done) bits.push("Geklommen");
    if (row.wishlist) bits.push("Bucket list");
    return bits.join(" · ") || "—";
  }

  function rideDateSortKey(row) {
    const raw = row.stravaActivityStartAt ?? row.doneAt ?? row.updatedAt;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  async function rebuildEnrichedCache() {
    const rows = logRows();
    const out = [];
    for (const row of rows) {
      const climb = await climbMeta(row.datasetId, row.climbId);
      const elev = Number(climb?.stats?.elevation_gain_m);
      const displayName = row.stravaClimbName || climb?.name || row.climbId || "Klim";
      const category = normalizeCategoryFromClimb(climb);
      out.push({
        row,
        displayName,
        country: rowCountry(row),
        regionLabel: rowRegionLabel(row),
        year: log?.logbookEntryYear?.(row) ?? null,
        category,
        categoryLabel: categoryDisplayLabel(category),
        elevation: Number.isFinite(elev) ? elev : 0,
        statusLabel: rowStatusLabel(row),
        rideDateLabel: log?.formatStravaRideDate?.(row) || "",
        rideDateSort: rideDateSortKey(row),
        hasStrava: Boolean(row.stravaActivityId),
      });
    }
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

  function passesTableSearch(item) {
    const q = tableSearchQuery.trim().toLowerCase();
    if (!q) return true;
    const hay = [
      item.displayName,
      item.country,
      countryLabel(item.country),
      item.regionLabel,
      item.row.datasetId,
      item.row.climbId,
      item.statusLabel,
      item.categoryLabel,
      item.row.stravaActivityName,
      String(item.row.stravaActivityId || ""),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  }

  function compareEnriched(a, b) {
    const dir = tableSortDir === "desc" ? -1 : 1;
    const key = tableSortKey;
    const cmpStr = (x, y) => String(x ?? "").localeCompare(String(y ?? ""), "nl", { sensitivity: "base" });
    const cmpNum = (x, y) => {
      const nx = Number(x);
      const ny = Number(y);
      if (!Number.isFinite(nx) && !Number.isFinite(ny)) return 0;
      if (!Number.isFinite(nx)) return 1;
      if (!Number.isFinite(ny)) return -1;
      return nx - ny;
    };
    let c = 0;
    switch (key) {
      case "name":
        c = cmpStr(a.displayName, b.displayName);
        break;
      case "country":
        c = cmpStr(countryLabel(a.country), countryLabel(b.country));
        break;
      case "region":
        c = cmpStr(a.regionLabel, b.regionLabel);
        break;
      case "category":
        c = compareCategoryKeys(a.category, b.category);
        break;
      case "elevation":
        c = cmpNum(a.elevation, b.elevation);
        break;
      case "year":
        c = cmpNum(a.year, b.year);
        break;
      case "status":
        c = cmpStr(a.statusLabel, b.statusLabel);
        break;
      case "rideDate":
        c = cmpNum(a.rideDateSort, b.rideDateSort);
        break;
      default:
        c = cmpStr(a.displayName, b.displayName);
    }
    if (c === 0) c = cmpStr(a.displayName, b.displayName);
    return c * dir;
  }

  function filteredByPanelFilters() {
    return enrichedCache.filter(passesFilters);
  }

  function filteredEnriched() {
    return filteredByPanelFilters().filter(passesTableSearch).sort(compareEnriched);
  }

  function updateSortHeaderAria() {
    const table = $("logbookTable");
    if (!table) return;
    for (const th of table.querySelectorAll(".logbook-th-sort")) {
      const key = th.getAttribute("data-sort");
      if (key === tableSortKey) {
        th.setAttribute("aria-sort", tableSortDir === "asc" ? "ascending" : "descending");
      } else {
        th.setAttribute("aria-sort", "none");
      }
    }
  }

  function fillFilterOptions() {
    const countrySel = $("logbookCountryFilter");
    const catSel = $("logbookCategoryFilter");
    const codes = new Set();
    const cats = new Set();
    for (const item of enrichedCache) {
      if (item.country) codes.add(item.country);
      cats.add(item.category || "__uncat__");
    }
    if (countrySel) {
      const sorted = [...codes].sort();
      countrySel.innerHTML =
        `<option value="">Alle landen</option>` +
        sorted.map((c) => `<option value="${c}">${escapeHtml(countryLabel(c))}</option>`).join("");
      countrySel.value = filters.country;
    }
    if (catSel) {
      const sorted = [...cats].sort(compareCategoryKeys);
      catSel.innerHTML =
        `<option value="">Alle categorieën</option>` +
        sorted
          .map(
            (c) =>
              `<option value="${escapeHtml(c)}">${escapeHtml(categoryDisplayLabel(c))}</option>`
          )
          .join("");
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
    const searchEl = $("logbookTableSearch");
    searchEl?.addEventListener("input", () => {
      clearTimeout(tableSearchTimer);
      tableSearchTimer = setTimeout(() => {
        tableSearchQuery = searchEl.value || "";
        try {
          sessionStorage.setItem(TABLE_SEARCH_KEY, tableSearchQuery);
        } catch {
          /* ignore */
        }
        void renderAll();
      }, 180);
    });
    $("logbookTable")?.querySelectorAll(".logbook-th-sort").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.getAttribute("data-sort");
        if (!key) return;
        if (tableSortKey === key) {
          tableSortDir = tableSortDir === "asc" ? "desc" : "asc";
        } else {
          tableSortKey = key;
          tableSortDir = key === "name" || key === "country" || key === "region" ? "asc" : "desc";
        }
        updateSortHeaderAria();
        void renderAll();
      });
      th.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          th.click();
        }
      });
    });
  }

  function renderTableRow(item) {
    const row = item.row;
    const tr = document.createElement("tr");
    const climbLabel = item.displayName;
    const actId = row.stravaActivityId;
    const actLabel = row.stravaActivityName || (actId ? `Rit ${actId}` : "—");

    const tdName = document.createElement("td");
    tdName.className = "logbook-td-name";
    if (row.datasetId && row.climbId && log?.databaseClimbUrl) {
      const climbLink = document.createElement("a");
      climbLink.href = log.databaseClimbUrl(row.datasetId, row.climbId, { back: "logbook" });
      climbLink.textContent = climbLabel;
      climbLink.className = "strava-match-climb-link";
      climbLink.addEventListener("click", () => log.rememberNavBack?.("logbook"));
      tdName.appendChild(climbLink);
    } else {
      tdName.textContent = climbLabel;
    }
    if (row.stravaActivityId) {
      tdName.appendChild(stravaMarkElement());
    }
    const dsHint = document.createElement("span");
    dsHint.className = "logbook-td-dataset";
    dsHint.textContent = row.datasetId || "";
    dsHint.title = row.datasetId || "";
    tdName.appendChild(dsHint);

    const tdCountry = document.createElement("td");
    tdCountry.textContent = countryLabel(item.country);

    const tdRegion = document.createElement("td");
    tdRegion.className = "logbook-td-region";
    tdRegion.textContent = item.regionLabel;
    tdRegion.title = item.regionLabel;

    const tdCat = document.createElement("td");
    tdCat.className = "logbook-td-num";
    tdCat.textContent = item.category === "__uncat__" ? "—" : item.category === "HC" ? "HC" : item.category;

    const tdElev = document.createElement("td");
    tdElev.className = "logbook-td-num";
    tdElev.textContent = item.elevation ? formatNlInteger(item.elevation) : "—";

    const tdYear = document.createElement("td");
    tdYear.className = "logbook-td-num";
    tdYear.textContent = item.year != null ? String(item.year) : "—";

    const tdStatus = document.createElement("td");
    tdStatus.className = "logbook-td-status";
    tdStatus.textContent = item.statusLabel;

    const tdRide = document.createElement("td");
    tdRide.className = "logbook-td-ride";
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
      tdRide.appendChild(stravaLink);
    } else {
      tdRide.textContent = "—";
    }

    const tdDate = document.createElement("td");
    tdDate.className = "logbook-td-date";
    tdDate.textContent = item.rideDateLabel || "—";

    const tdAction = document.createElement("td");
    tdAction.className = "logbook-td-actions";
    if (row.stravaActivityId) {
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
      tdAction.appendChild(unlink);
    } else {
      tdAction.textContent = "—";
    }

    tr.append(tdName, tdCountry, tdRegion, tdCat, tdElev, tdYear, tdStatus, tdRide, tdDate, tdAction);
    return tr;
  }

  async function renderList() {
    const tbody = $("logbookTableBody");
    const wrap = $("logbookTableWrap");
    const empty = $("logbookListEmpty");
    const summary = $("logbookListSummary");
    if (!tbody) return;

    const items = filteredEnriched();
    const total = logRows().length;
    tbody.innerHTML = "";
    if (wrap) wrap.hidden = total === 0;
    if (empty) empty.hidden = total > 0;

    updateSortHeaderAria();

    if (summary) {
      summary.textContent =
        total === 0
          ? "Nog geen klimmen in je logboek (gedaan of bucket list)."
          : `${formatNlInteger(items.length)} van ${formatNlInteger(total)} klim(men) binnen je filters en zoekterm`;
    }
    for (const item of items) {
      tbody.appendChild(renderTableRow(item));
    }
  }

  async function renderStats() {
    const summaryEl = $("logbookStatsSummary");
    const grid = $("logbookStatsGrid");
    const details = $("logbookStatsDetails");
    const breakdown = $("logbookStatsBreakdown");
    const items = filteredByPanelFilters().filter((i) => i.row.done);
    if (!summaryEl) return;

    if (!items.length) {
      summaryEl.textContent =
        filteredByPanelFilters().length === 0
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
      const cc = item.country || "?";
      byCountry.set(cc, (byCountry.get(cc) || 0) + 1);

      const year = item.year;
      const yearKey = year != null ? year : "__unknown_year__";
      byYear.set(yearKey, (byYear.get(yearKey) || 0) + 1);

      const cat = item.category || "__uncat__";
      byCategory.set(cat, (byCategory.get(cat) || 0) + 1);
      totalElev += item.elevation;
    }

    summaryEl.textContent = `Statistieken over ${formatNlInteger(items.length)} geklommen klim(men) binnen je filters. Jaar = Strava-ritdatum indien bekend, anders datum van handmatig vinken.`;

    if (grid) {
      grid.hidden = false;
      grid.innerHTML = `
        <div class="logbook-stat-card"><strong>${formatNlInteger(items.length)}</strong><span>geklommen</span></div>
        <div class="logbook-stat-card"><strong>${formatNlInteger(byCountry.size)}</strong><span>landen</span></div>
        <div class="logbook-stat-card"><strong>${formatNlInteger(Math.round(totalElev))}</strong><span>hoogtemeters (som)</span></div>
        <div class="logbook-stat-card"><strong>${formatNlInteger(byCategory.size)}</strong><span>categorieën</span></div>`;
    }

    if (details && breakdown) {
      details.hidden = false;
      const countryLines = [...byCountry.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([c, n]) => `<li>${escapeHtml(countryLabel(c))}: ${formatNlInteger(n)}</li>`)
        .join("");
      const yearLines = [...byYear.entries()]
        .sort((a, b) => {
          const ya = a[0] === "__unknown_year__" ? -1 : Number(a[0]);
          const yb = b[0] === "__unknown_year__" ? -1 : Number(b[0]);
          return yb - ya;
        })
        .map(([y, n]) => {
          const label = y === "__unknown_year__" ? "onbekend jaar" : String(y);
          return `<li>${escapeHtml(label)}: ${formatNlInteger(n)}</li>`;
        })
        .join("");
      const catLines = [...byCategory.entries()]
        .sort((a, b) => compareCategoryKeys(a[0], b[0]))
        .map(([c, n]) => `<li>${escapeHtml(categoryDisplayLabel(c))}: ${formatNlInteger(n)}</li>`)
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

  function loadTableSearchFromStorage() {
    try {
      tableSearchQuery = sessionStorage.getItem(TABLE_SEARCH_KEY) || "";
    } catch {
      tableSearchQuery = "";
    }
    const searchEl = $("logbookTableSearch");
    if (searchEl) searchEl.value = tableSearchQuery;
  }

  async function boot() {
    if (!log) return;
    loadFiltersFromStorage();
    loadTableSearchFromStorage();
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
