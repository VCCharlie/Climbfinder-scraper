/** Logboek-pagina: Strava-koppelingen, filters, statistieken, ontkoppelen. */
(function (global) {
  const log = global.FietsKlimClimbLog;

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
  let countryFilter = "";

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

  function linkedRows() {
    return log?.isReady?.() && log.listStravaLinked ? log.listStravaLinked() : [];
  }

  function rowCountry(row) {
    return datasetCountry.get(row.datasetId) || "";
  }

  function filteredRows() {
    const rows = linkedRows();
    if (!countryFilter) return rows;
    return rows.filter((r) => rowCountry(r) === countryFilter);
  }

  function fillCountryFilter() {
    const sel = $("logbookCountryFilter");
    if (!sel) return;
    const codes = new Set();
    for (const r of linkedRows()) {
      const c = rowCountry(r);
      if (c) codes.add(c);
    }
    const sorted = [...codes].sort();
    sel.innerHTML =
      `<option value="">Alle landen</option>` +
      sorted.map((c) => `<option value="${c}">${escapeHtml(countryLabel(c))}</option>`).join("");
    sel.value = countryFilter;
    sel.onchange = () => {
      countryFilter = sel.value;
      void renderList();
    };
  }

  function renderListItem(row) {
    const li = document.createElement("li");
    const climbLabel = row.stravaClimbName || row.climbId || "Klim";
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

    const wrap = document.createElement("span");
    wrap.innerHTML = ds;
    li.appendChild(wrap);
    li.appendChild(strong);
    li.appendChild(document.createTextNode(" → "));

    const stravaLink = document.createElement("a");
    stravaLink.textContent = actLabel;
    if (log?.applyStravaActivityAnchor && actId) {
      log.applyStravaActivityAnchor(stravaLink, actId);
    } else if (actId) {
      stravaLink.href = `https://www.strava.com/activities/${actId}`;
      stravaLink.target = "_blank";
      stravaLink.rel = "noopener noreferrer";
    }
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

    return li;
  }

  async function renderList() {
    const ul = $("logbookStravaList");
    const empty = $("logbookListEmpty");
    const summary = $("logbookListSummary");
    if (!ul) return;

    const rows = filteredRows();
    ul.innerHTML = "";
    if (empty) empty.hidden = rows.length > 0;
    if (summary) {
      const total = linkedRows().length;
      summary.textContent = countryFilter
        ? `${rows.length} van ${total} koppeling(en) (${countryLabel(countryFilter)})`
        : `${rows.length} koppeling(en)`;
    }
    for (const row of rows) {
      ul.appendChild(renderListItem(row));
    }
  }

  async function renderStats() {
    const summaryEl = $("logbookStatsSummary");
    const grid = $("logbookStatsGrid");
    const details = $("logbookStatsDetails");
    const breakdown = $("logbookStatsBreakdown");
    const rows = linkedRows().filter((r) => r.done);
    if (!summaryEl) return;

    if (!rows.length) {
      summaryEl.textContent = "Nog geen geklommen klimmen met Strava-koppeling.";
      if (grid) grid.hidden = true;
      if (details) details.hidden = true;
      return;
    }

    const byCountry = new Map();
    const byYear = new Map();
    const byCategory = new Map();
    let totalElev = 0;
    let metaLoaded = 0;

    for (const row of rows) {
      const cc = rowCountry(row) || "?";
      byCountry.set(cc, (byCountry.get(cc) || 0) + 1);

      const year = log?.stravaRideYear?.(row) ?? new Date().getFullYear();
      byYear.set(year, (byYear.get(year) || 0) + 1);

      const climb = await climbMeta(row.datasetId, row.climbId);
      metaLoaded += 1;
      const cat =
        climb?.climbfinder?.category ||
        climb?.classification ||
        climb?.stats?.classification ||
        "?";
      byCategory.set(cat, (byCategory.get(cat) || 0) + 1);
      const elev = Number(climb?.stats?.elevation_gain_m);
      if (Number.isFinite(elev)) totalElev += elev;
    }

    summaryEl.textContent = `Op basis van ${rows.length} geklommen Strava-koppeling(en) (${metaLoaded} met klimdata). Jaar = Strava-ritdatum (lokaal); zonder datum valt terug op “gedaan” in logboek.`;

    if (grid) {
      grid.hidden = false;
      grid.innerHTML = `
        <div class="logbook-stat-card"><strong>${rows.length}</strong><span>geklommen (Strava)</span></div>
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

  async function refresh() {
    if (!log?.isReady?.()) return;
    await loadIndex();
    fillCountryFilter();
    await Promise.all([renderList(), renderStats()]);
  }

  async function boot() {
    if (!log) return;
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
