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
        category: normalizeCategoryFromClimb(climb),
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
          : `${formatNlInteger(items.length)} van ${formatNlInteger(total)} klim(men) binnen je filters`;
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
