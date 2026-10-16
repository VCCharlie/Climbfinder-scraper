/** Strava koppelen, voorkeuren (privé), proef- en volledige sync. */
(function (global) {
  const DATASET_STORAGE_KEY = "fietsklim-strava-dataset-id";
  const INCLUDE_PRIVATE_STORAGE_KEY = "fietsklim-strava-include-private";
  const ALL_DATASETS = "__all__";
  const DEFAULT_PER_PAGE = 50;
  const FULL_SYNC_MAX_LOOPS = 80;
  const FULL_SYNC_MAX_LOOPS_ALL = 800;
  const FULL_SYNC_WANTED_KEY = "fietsklim-strava-full-sync-wanted";
  const SERVER_JOB_POLL_MS = 15000;

  let statusCache = null;
  let serverJobPollTimer = null;
  let prefsSaveTimer = null;
  let fullSyncRunning = false;
  let wakeLockSentinel = null;

  async function acquireWakeLock() {
    try {
      if (global.navigator?.wakeLock?.request) {
        wakeLockSentinel = await navigator.wakeLock.request("screen");
        wakeLockSentinel?.addEventListener?.("release", () => {
          wakeLockSentinel = null;
        });
      }
    } catch (_) {
      /* optional API */
    }
  }

  function releaseWakeLock() {
    try {
      void wakeLockSentinel?.release();
    } catch (_) {
      /* ignore */
    }
    wakeLockSentinel = null;
  }

  function lastSyncIncomplete(d) {
    const s = d?.lastSyncSummary;
    return Boolean(s && s.kind === "full" && s.completed === false);
  }

  function syncScopeMatchesWanted(wanted, summary) {
    if (!wanted || !summary) return false;
    if (wanted === ALL_DATASETS) return Boolean(summary.allDatasets);
    return wanted === summary.datasetId;
  }

  function maybeResumeFullSync(d) {
    if (fullSyncRunning) return;
    if (serverJobActive(d?.activeSyncJob)) {
      startServerJobPolling();
      return;
    }
    if (getSelectedDatasetId() === ALL_DATASETS && fullDatabaseUsesCplRoutes()) {
      return;
    }
    const wanted = sessionStorage.getItem(FULL_SYNC_WANTED_KEY);
    if (!wanted || !lastSyncIncomplete(d) || !syncScopeMatchesWanted(wanted, d.lastSyncSummary)) {
      return;
    }
    const select = $("stravaDatasetSelect");
    if (select && select.value !== wanted) {
      select.value = wanted;
      setStoredDatasetId(wanted);
    }
    setStatus("Volledige sync hervatten (checkpoint op server)…", false);
    void fullSync({ resumeFromCheckpoint: true });
  }

  function cfg() {
    return global.FIETSKLIM_AUTH_CONFIG || {};
  }

  function fnRegion() {
    return cfg().strava?.region || cfg().githubImport?.region || "europe-west1";
  }

  function useBackgroundFullSync() {
    return Boolean(cfg().strava?.backgroundSync);
  }

  function showServerSyncBetaButton() {
    return cfg().strava?.showServerSyncBeta !== false;
  }

  function serverJobActive(job) {
    return job && (job.status === "queued" || job.status === "running");
  }

  function stopServerJobPolling() {
    if (serverJobPollTimer) {
      clearInterval(serverJobPollTimer);
      serverJobPollTimer = null;
    }
  }

  function startServerJobPolling() {
    stopServerJobPolling();
    const tick = () => {
      void refreshStatus();
    };
    tick();
    serverJobPollTimer = setInterval(tick, SERVER_JOB_POLL_MS);
  }

  function logbookChannelLabel(viaCpl) {
    return viaCpl ? "Logboek · CPL · Intervals→Strava" : "Logboek · Strava API";
  }

  function renderLogbookRouteStatus() {
    const el = $("logbookRouteStatus");
    if (!el) return;
    const cpl = statusCache?.cplStatus;
    if (!cpl) {
      el.textContent =
        "Performance Lab: status niet geladen (deploy getCplStatus of ververs de pagina).";
      return;
    }
    if (cpl.linked && cpl.serverSyncConfigured) {
      const mail = cpl.emailChecked ? ` (${cpl.emailChecked})` : "";
      el.textContent = `Performance Lab: gekoppeld${mail} · server-routes: Intervals-map, anders Strava-map`;
      return;
    }
    if (cpl.linked) {
      el.textContent = `Performance Lab: account gevonden · ${cpl.linkHint || "server-sync nog niet geconfigureerd"}`;
      return;
    }
    const reason =
      cpl.linkReason === "cpl_auth_lookup_denied"
        ? "server IAM"
        : cpl.linkReason === "lookup_failed"
          ? "lookup-fout"
          : "geen Auth-user";
    const hint =
      cpl.linkHint ||
      "Log in bij Climb Performance Lab met dezelfde Google-mail als FietsKlim.";
    el.textContent = `Performance Lab: niet gekoppeld (${reason}) · ${hint}`;
  }

  function activeCplSyncJobRef() {
    return statusCache?.activeCplSyncJob || statusCache?.cplStatus?.activeSyncJob || null;
  }

  function cplLastSyncSummaryRef() {
    const fromCpl = statusCache?.cplStatus?.lastSyncSummary;
    if (fromCpl) return fromCpl;
    const s = statusCache?.lastSyncSummary;
    return s?.source === "cpl" ? s : null;
  }

  function formatCplPeriodLabel(afterMs, beforeMs) {
    const fmt = (ms) =>
      ms != null && Number.isFinite(ms)
        ? new Date(ms).toLocaleDateString("nl-NL", { dateStyle: "medium" })
        : null;
    const a = fmt(afterMs);
    const b = fmt(beforeMs);
    if (a && b) return a === b ? a : `${a} – ${b}`;
    if (a) return `vanaf ${a}`;
    if (b) return `tot ${b}`;
    return "alle ritten";
  }

  function formatServerJobLine(job) {
    if (!job) return "";
    const p = job.progress || {};
    const viaCpl = job.routeSource === "cpl" || statusCache?.activeCplSyncJob?.id === job.id;
    const channel = logbookChannelLabel(viaCpl);
    const parts = [`${channel} · server · ${job.status}`];
    if (viaCpl && p.uniqueClimbs != null) parts.push(`${p.uniqueClimbs} klim-match`);
    if (p.regionProgress) parts.push(p.regionProgress);
    if (!viaCpl && p.nextPage) parts.push(`Strava pag. ${p.nextPage}`);
    if (p.activitiesScanned != null) parts.push(`${p.activitiesScanned} rit(ten)`);
    if (job.batchCount) parts.push(`batch ${job.batchCount}`);
    if (job.lastMessage) parts.push(job.lastMessage);
    return parts.join(" · ");
  }

  function renderCplSyncRunPanel() {
    const panel = $("logbookCplRunPanel");
    const headline = $("logbookCplRunHeadline");
    const factsEl = $("logbookCplRunFacts");
    if (!panel || !headline || !factsEl) return;

    const cpl = statusCache?.cplStatus;
    const linked = Boolean(cpl?.linked && cpl?.serverSyncConfigured);
    const job = activeCplSyncJobRef();
    const summary = cplLastSyncSummaryRef();
    const jobLive = serverJobActive(job);

    if (!linked && !summary && !jobLive) {
      panel.hidden = true;
      return;
    }

    panel.hidden = false;
    const facts = [];

    if (jobLive) {
      headline.textContent = `CPL server-sync loopt · ${formatServerJobLine(job)}`;
      facts.push("Tab mag dicht; status ververst automatisch.");
      if (job.after != null || job.before != null) {
        facts.push(`Job-periode: ${formatCplPeriodLabel(job.after, job.before)}`);
      }
    } else if (job?.status === "failed") {
      headline.textContent = `CPL server-sync mislukt`;
      facts.push(job.error || "Onbekende fout");
    } else if (job?.status === "completed") {
      headline.textContent = `CPL server-sync afgerond`;
      if (job.lastMessage) facts.push(job.lastMessage);
    } else if (summary) {
      const n = summary.matchesWritten ?? summary.uniqueClimbs ?? 0;
      const rides = summary.activitiesWithMap ?? summary.activitiesScanned ?? 0;
      headline.textContent =
        summary.completed
          ? `Laatste CPL-run: ${n} logboek-koppeling(en) · ${rides} rit(ten) met route`
          : `Laatste CPL-run (nog niet klaar): ${n} koppeling(en) tot nu toe`;
    } else {
      headline.textContent = "CPL server-sync — nog geen run gestart";
    }

    if (summary) {
      facts.push(`Periode in run: ${formatCplPeriodLabel(summary.after, summary.before)}`);
      facts.push(
        `Ritten met route in CPL (deze batch/run): ${summary.activitiesWithMap ?? summary.activitiesScanned ?? 0}`
      );
      if (summary.docsScanned != null) {
        facts.push(`Firestore docs gescand: ${summary.docsScanned}`);
      }
      if (summary.skippedNoMap > 0) {
        facts.push(
          `${summary.skippedNoMap} doc(s) in query zonder route-polyline (intervals_map/strava_map leeg in Firestore)`
        );
      }
      if (summary.skippedOutOfBounds > 0) {
        facts.push(
          `${summary.skippedOutOfBounds} doc(s) buiten gekozen periode (filter na query)`
        );
      }
      const noMapSamples = summary.noMapSamples || [];
      if (noMapSamples.length && (summary.activitiesWithMap ?? summary.activitiesScanned ?? 0) === 0) {
        for (const s of noMapSamples.slice(0, 3)) {
          const title = s.title ? `“${s.title}”` : s.id;
          const flags = [
            s.hasIntervalsMap ? "intervals_map≠leeg" : null,
            s.hasStravaMap ? "strava_map≠leeg" : null,
          ].filter(Boolean);
          facts.push(
            `CPL-activiteit zonder leesbare polyline: ${title} (${s.date || "?"})${flags.length ? ` — veld aanwezig maar niet parseerbaar: ${flags.join(", ")}` : " — run Strava/Intervals map-backfill in CPL"}`
          );
        }
      }
      facts.push(
        `Logboek bijgewerkt (matchesWritten): ${summary.matchesWritten ?? summary.uniqueClimbs ?? 0}`
      );
      if (summary.regionProgress) facts.push(`Regio’s: ${summary.regionProgress}`);
      if (summary.completed) facts.push("Status run: afgerond");
      else if (!jobLive) facts.push("Status run: onderbroken of wacht op volgende batch");
      if (summary.dateQueryIndexRequired) {
        facts.push(
          "Datumbereik-query mislukt — composite index activities (ownerId + date) op climb-performance-lab"
        );
      } else if (
        (summary.activitiesWithMap ?? summary.activitiesScanned ?? 0) === 0 &&
        (summary.after != null || summary.before != null)
      ) {
        facts.push(
          "0 ritten met route → na deploy: datumbereik gebruikt date < dag+1 (ISO-tijden op dezelfde dag). Anders: ownerId + intervals_map/strava_map in CPL Firestore"
        );
      } else if ((summary.matchesWritten ?? 0) === 0 && (summary.activitiesScanned ?? 0) > 0) {
        facts.push(
          "Ritten gevonden maar 0 klim-match → strikte polyline-check (route moet op klim liggen; afdaling telt niet)"
        );
      }
      if (cpl?.lastSyncAt) {
        facts.push(`Laatst opgeslagen: ${new Date(cpl.lastSyncAt).toLocaleString("nl-NL")}`);
      }
    }

    factsEl.innerHTML = "";
    for (const line of facts) {
      const li = document.createElement("li");
      li.textContent = line;
      factsEl.appendChild(li);
    }

    const matches = summary?.matches || [];
    const matchDetails = $("logbookCplRunMatchesDetails");
    if (matchDetails) matchDetails.hidden = !matches.length;
    fillMatchList(
      $("logbookCplRunMatchList"),
      matches,
      $("logbookCplRunMatchEmpty"),
      { back: "settings" }
    );
  }

  function fullDatabaseUsesCplRoutes() {
    if (getSelectedDatasetId() !== ALL_DATASETS) return false;
    if (statusCache?.routeSync?.fullDatabaseUsesCpl) return true;
    const cpl = statusCache?.cplStatus;
    return Boolean(cpl?.linked && cpl?.serverSyncConfigured);
  }

  function serverSyncButtonLabel() {
    const range = hasSyncDateRange();
    const all = getSelectedDatasetId() === ALL_DATASETS;
    const cpl = all && fullDatabaseUsesCplRoutes();
    if (cpl) {
      return range
        ? "Logboek · CPL · Intervals→Strava · periode (server)"
        : "Logboek · CPL · Intervals→Strava · hele database (server)";
    }
    if (all) {
      return range
        ? "Logboek · Strava API · periode (server)"
        : "Logboek · Strava API · hele database (server)";
    }
    return range
      ? "Logboek · Strava API · periode (server)"
      : "Logboek · Strava API · regio (server)";
  }

  function browserSyncAllowed() {
    if (!fullDatabaseUsesCplRoutes()) return true;
    return getSelectedDatasetId() !== ALL_DATASETS;
  }

  function formatCallableError(e) {
    if (!e) return "Onbekende fout";
    const code = e.code ? String(e.code).replace(/^functions\//, "") : "";
    const details = typeof e.details === "string" ? e.details.trim() : "";
    const msg = e.message || String(e);
    if (details && details !== msg && details !== code) {
      return details;
    }
    if (code === "failed-precondition" && msg && msg !== "failed-precondition") {
      return msg;
    }
    if (code === "internal" && (msg === "internal" || msg === "INTERNAL")) {
      return "Interne serverfout — bij server-sync: vaak Cloud Tasks-queue strava-sync of Enqueuer op @appspot. Zie docs/auth/STRAVA.md (Phase 3).";
    }
    if (code === "deadline-exceeded") {
      return msg || "Sync-batch timeout — klik opnieuw Volledige history sync (loopt verder).";
    }
    if (/not-found|UNIMPLEMENTED/i.test(code) || /not-found|UNIMPLEMENTED/i.test(msg)) {
      return "Strava-function setStravaSyncPrefs ontbreekt — draai GitHub workflow “Deploy Climbfinder import function”. Zie docs/auth/STRAVA.md.";
    }
    if (code && msg !== code && !msg.includes(code)) return `${msg} (${code})`;
    return msg || code || "Onbekende fout";
  }

  function callable(name) {
    if (typeof firebase === "undefined" || !firebase.app) {
      throw new Error("Firebase niet geladen.");
    }
    const fnFactory = firebase.app().functions;
    if (typeof fnFactory !== "function") {
      throw new Error(
        "Firebase Functions SDK ontbreekt — hard refresh (Ctrl+Shift+R) na deploy van index.html."
      );
    }
    return fnFactory.call(firebase.app(), fnRegion()).httpsCallable(name);
  }

  function $(id) {
    return document.getElementById(id);
  }

  function getSyncDateBoundsPayload() {
    const from = $("stravaSyncDateFrom")?.value?.trim();
    const to = $("stravaSyncDateTo")?.value?.trim();
    const payload = {};
    if (from) {
      const after = new Date(`${from}T00:00:00`).getTime();
      if (Number.isFinite(after)) payload.after = after;
    }
    if (to) {
      const before = new Date(`${to}T23:59:59.999`).getTime();
      if (Number.isFinite(before)) payload.before = before;
    }
    if (
      payload.after != null &&
      payload.before != null &&
      payload.after >= payload.before
    ) {
      return { error: "Datum ‘tot’ moet na ‘van’ liggen." };
    }
    return { payload };
  }

  function setStatus(text, isError) {
    const el = $("stravaSyncStatus");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("is-error", Boolean(isError));
    if (!el.classList.contains("settings-status")) {
      el.style.color = isError ? "#b91c1c" : "#64748b";
    }
  }

  function escapeHtml(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fillMatchList(ul, items, emptyEl, options = {}) {
    if (!ul) return;
    ul.innerHTML = "";
    const list = items || [];
    if (emptyEl) emptyEl.hidden = list.length > 0;
    const log = global.FietsKlimClimbLog;
    const backKey = options.back || "settings";

    for (const m of list) {
      const li = document.createElement("li");
      const climbLabel = m.climbName || m.stravaClimbName || m.climbId || "Klim";
      const climbId = m.climbId;
      const datasetId = m.datasetId;
      const actId = m.activityId || m.stravaActivityId;
      const actLabel = m.activityName || m.stravaActivityName || (actId ? `Rit ${actId}` : "Strava-rit");

      if (m.datasetId) {
        const dsSpan = document.createElement("span");
        dsSpan.className = "strava-match-dataset";
        dsSpan.textContent = m.datasetId;
        li.appendChild(dsSpan);
        li.appendChild(document.createTextNode(" · "));
      }

      const strong = document.createElement("strong");
      if (datasetId && climbId && log?.databaseClimbUrl) {
        const climbLink = document.createElement("a");
        climbLink.href = log.databaseClimbUrl(datasetId, climbId, { back: backKey });
        climbLink.textContent = climbLabel;
        climbLink.className = "strava-match-climb-link";
        climbLink.addEventListener("click", () => log.rememberNavBack?.(backKey));
        strong.appendChild(climbLink);
      } else {
        strong.textContent = climbLabel;
      }
      li.appendChild(strong);
      li.appendChild(document.createTextNode(" → "));

      const stravaLink = document.createElement("a");
      stravaLink.textContent = actLabel;
      if (log?.applyStravaActivityAnchor && actId) {
        log.applyStravaActivityAnchor(stravaLink, actId);
      } else {
        stravaLink.href = actId ? `https://www.strava.com/activities/${actId}` : "#";
        stravaLink.target = "_blank";
        stravaLink.rel = "noopener noreferrer";
      }
      li.appendChild(stravaLink);

      ul.appendChild(li);
    }
  }

  function focusStravaSettingsFromHash() {
    const hash = (global.location.hash || "").replace("#", "");
    if (hash !== "stravaSettingsCard") return;
    const card = $("stravaSettingsCard");
    card?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }

  function renderStravaMatchPanels() {
    const wrap = $("stravaMatchPanels");
    const totalEl = $("stravaMatchTotal");
    if (!wrap) return;

    const connected = Boolean(statusCache?.connected);
    wrap.hidden = !connected;
    if (!connected) return;

    const log = global.FietsKlimClimbLog;
    const linked = log?.isReady?.() && log.listStravaLinked ? log.listStravaLinked() : [];

    if (totalEl) {
      totalEl.innerHTML = linked.length
        ? `${linked.length} klim(men) gekoppeld — zie <a href="logbook.html">Logboek</a>`
        : "Nog geen klimmen met Strava-rit in je logboek";
    }

    const lastMatches = statusCache?.lastSyncSummary?.matches;
    fillMatchList($("stravaLastSyncMatchList"), lastMatches, $("stravaLastSyncMatchEmpty"), {
      back: "settings",
    });
  }

  function setupHint(setup) {
    if (!setup || setup.backendConfigured) return "";
    return " Server: strava.client_id/secret nog niet gezet — functions:config:set + Deploy Functions.";
  }

  function getLocalIncludePrivate() {
    try {
      return localStorage.getItem(INCLUDE_PRIVATE_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  }

  function setLocalIncludePrivate(on) {
    try {
      localStorage.setItem(INCLUDE_PRIVATE_STORAGE_KEY, on ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  function includePrivateChecked() {
    return Boolean($("stravaIncludePrivate")?.checked);
  }

  function updatePrivateHint(d) {
    const hint = $("stravaPrivateHint");
    if (!hint) return;
    if (!d?.connected) {
      hint.hidden = true;
      hint.textContent = "";
      return;
    }
    if (d.needsReconnect) {
      hint.hidden = false;
      hint.classList.add("is-error");
      const scopeNote = d.grantedScope ? ` (opgeslagen scope: ${d.grantedScope})` : "";
      hint.textContent =
        "Privé staat aan, maar activity:read_all ontbreekt nog in de koppeling" +
        scopeNote +
        " — tik Ververs Strava-toestemming (privé). Na deploy Functions: pagina verversen.";
      return;
    }
    hint.classList.remove("is-error");
    if (d.includePrivate) {
      hint.hidden = false;
      hint.textContent = "Sync gebruikt publieke én privé fietsritten.";
    } else {
      hint.hidden = false;
      hint.textContent = "Sync gebruikt alleen publieke fietsritten.";
    }
  }

  function syncToggleFromStatus(d) {
    const box = $("stravaIncludePrivate");
    if (!box) return;
    if (d?.includePrivate !== undefined) {
      box.checked = Boolean(d.includePrivate);
      setLocalIncludePrivate(box.checked);
      return;
    }
    box.checked = getLocalIncludePrivate();
  }

  function getStoredDatasetId() {
    try {
      return localStorage.getItem(DATASET_STORAGE_KEY) || "";
    } catch {
      return "";
    }
  }

  function setStoredDatasetId(id) {
    try {
      if (id) localStorage.setItem(DATASET_STORAGE_KEY, id);
      else localStorage.removeItem(DATASET_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  function getSelectedDatasetId() {
    const sel = $("stravaDatasetSelect");
    const fromSelect = sel?.value?.trim();
    if (fromSelect) return fromSelect;
    return getStoredDatasetId();
  }

  async function loadRegionIndex() {
    const url = new URL("data/index.json", global.location.href).href;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`index.json laden mislukt (${res.status})`);
    return res.json();
  }

  function sortRegions(regions) {
    return [...regions].sort((a, b) => {
      const ta = (a.displayTitle || a.title || a.id || "").toLowerCase();
      const tb = (b.displayTitle || b.title || b.id || "").toLowerCase();
      return ta.localeCompare(tb, "nl");
    });
  }

  async function populateDatasetSelect() {
    const sel = $("stravaDatasetSelect");
    if (!sel) return;
    sel.disabled = true;
    sel.innerHTML = '<option value="">Laden…</option>';
    try {
      const index = await loadRegionIndex();
      const regions = sortRegions(index.regions || []);
      const total =
        index.total_climbs ??
        regions.reduce((sum, r) => sum + (Number(r.count) || 0), 0);
      sel.innerHTML = '<option value="">— kies regio of hele database —</option>';
      const allOpt = document.createElement("option");
      allOpt.value = ALL_DATASETS;
      allOpt.textContent = `Hele database (${regions.length} regio’s, ${Number(total).toLocaleString("nl-NL")} klimmen)`;
      sel.appendChild(allOpt);
      for (const r of regions) {
        const opt = document.createElement("option");
        opt.value = r.id;
        opt.textContent = `${r.displayTitle || r.title || r.id} (${r.count ?? 0})`;
        sel.appendChild(opt);
      }
      const stored = getStoredDatasetId();
      const cfgDefault = cfg().strava?.defaultDatasetId;
      const pick = stored || cfgDefault || "";
      if (pick && (pick === ALL_DATASETS || regions.some((r) => r.id === pick))) {
        sel.value = pick;
      }
      sel.disabled = false;
    } catch (e) {
      sel.innerHTML = `<option value="">Fout: ${e.message}</option>`;
    }
  }

  function hasSyncDateRange() {
    const bounds = getSyncDateBoundsPayload();
    if (bounds.error) return false;
    return bounds.payload.after != null || bounds.payload.before != null;
  }

  function updateSyncButtonsVisibility(connected) {
    const loggedIn = Boolean(typeof firebase !== "undefined" && firebase.auth?.().currentUser);
    const datasetOk = Boolean(getSelectedDatasetId());
    const period = $("stravaPeriodSyncBtn");
    const trial = $("stravaTrialSyncBtn");
    const full = $("stravaFullSyncBtn");
    const cleanup = $("stravaCleanupBtn");
    const browserDetails = $("stravaBrowserSyncDetails");
    const show = connected && datasetOk;
    const range = hasSyncDateRange();
    const browserOk = show && browserSyncAllowed();
    browserDetails?.toggleAttribute("hidden", !browserOk);
    period?.toggleAttribute("hidden", !browserOk || !range);
    trial?.toggleAttribute("hidden", !browserOk || range);
    full?.toggleAttribute("hidden", !browserOk);
    if (period) period.disabled = !browserOk || !range;
    if (trial) trial.disabled = !browserOk || range;
    if (full) {
      full.disabled =
        !browserOk || Boolean(statusCache?.needsReconnect && includePrivateChecked());
      full.textContent = range
        ? "Strava API · volledig · periode (browser)"
        : "Strava API · volledig (browser)";
    }
    cleanup?.toggleAttribute("hidden", !connected);
    if (cleanup) cleanup.disabled = !connected;
    const serverBtn = $("stravaServerFullSyncBtn");
    const cancelServer = $("stravaCancelServerSyncBtn");
    const job = statusCache?.activeSyncJob;
    const jobRunning = serverJobActive(job);
    const cplServerOk = loggedIn && datasetOk && fullDatabaseUsesCplRoutes();
    const stravaServerOk =
      connected &&
      datasetOk &&
      (useBackgroundFullSync() || showServerSyncBetaButton());
    const showServer = cplServerOk || stravaServerOk;
    serverBtn?.toggleAttribute("hidden", !showServer || jobRunning);
    cancelServer?.toggleAttribute("hidden", !loggedIn || !jobRunning);
    if (serverBtn) {
      const viaCpl = fullDatabaseUsesCplRoutes();
      serverBtn.disabled =
        !showServer ||
        jobRunning ||
        (!viaCpl && Boolean(statusCache?.needsReconnect && includePrivateChecked()));
      serverBtn.textContent = serverSyncButtonLabel();
      serverBtn.title = viaCpl
        ? "Server: CPL Firestore, route Intervals-map dan Strava-map, logboek source cpl"
        : "Server: Strava API, tab mag dicht";
    }
    if (cancelServer) cancelServer.disabled = !jobRunning;
    const sel = $("stravaDatasetSelect");
    if (sel && global.__FIETSKLIM_AUTH_READY) sel.removeAttribute("hidden");
  }

  async function savePrefsFromToggle() {
    if (!firebase.auth?.().currentUser) return;
    const includePrivate = includePrivateChecked();
    setLocalIncludePrivate(includePrivate);
    try {
      const res = await callable("setStravaSyncPrefs")({
        includePrivate,
      });
      const d = res.data || {};
      if (statusCache) {
        statusCache.includePrivate = d.includePrivate;
        statusCache.needsReconnect = d.needsReconnect;
      }
      updatePrivateHint(statusCache || d);
      updateSyncButtonsVisibility(statusCache?.connected);
      if (d.needsReconnect) {
        setStatus(d.message || "Koppel Strava opnieuw voor privé.", true);
      } else if (d.message) {
        setStatus(d.message);
      }
    } catch (e) {
      const msg = formatCallableError(e);
      if (/setStravaSyncPrefs|niet gedeployed|Deploy Climbfinder/i.test(msg)) {
        setStatus(
          "Privé-voorkeur lokaal opgeslagen. Deploy de nieuwste Strava Functions, of klik Koppel Strava — die stuurt privé-scope mee bij opnieuw koppelen.",
          false
        );
        if (statusCache) {
          statusCache.includePrivate = includePrivate;
          statusCache.needsReconnect = includePrivate && statusCache.connected;
        }
        updatePrivateHint(statusCache || { connected: statusCache?.connected, includePrivate });
        updateSyncButtonsVisibility(statusCache?.connected);
        return;
      }
      setStatus(msg, true);
    }
  }

  function schedulePrefsSave() {
    clearTimeout(prefsSaveTimer);
    prefsSaveTimer = setTimeout(() => void savePrefsFromToggle(), 300);
  }

  async function refreshStatus() {
    if (typeof firebase === "undefined" || !firebase.auth?.().currentUser) {
      setStatus("Log in om Strava te koppelen.");
      updateSyncButtonsVisibility(false);
      return;
    }
    try {
      const res = await callable("getStravaStatus")({});
      const d = res.data || {};
      statusCache = d;
      try {
        const cplRes = await callable("getCplStatus")({});
        statusCache.cplStatus = cplRes.data || {};
        if (!statusCache.routeSync && statusCache.cplStatus?.linked) {
          statusCache.routeSync = {
            fullDatabaseUsesCpl: Boolean(statusCache.cplStatus.serverSyncConfigured),
            cplWorkerConfigured: Boolean(statusCache.cplStatus.serverSyncConfigured),
          };
        }
      } catch (cplErr) {
        statusCache.cplStatus = statusCache.cplStatus || null;
      }
      renderLogbookRouteStatus();
      if (d.activeCplSyncJob) statusCache.activeCplSyncJob = d.activeCplSyncJob;
      renderCplSyncRunPanel();
      $("stravaConnectBtn")?.toggleAttribute("hidden", d.connected);
      $("stravaReconnectBtn")?.toggleAttribute(
        "hidden",
        !d.connected || !d.needsReconnect
      );
      $("stravaDisconnectBtn")?.toggleAttribute("hidden", !d.connected);
      syncToggleFromStatus(d);
      updatePrivateHint(d);
      updateSyncButtonsVisibility(d.connected);
      if (d.firestoreError) {
        setStatus(`Firestore-fout: ${d.hint || "?"}${setupHint(d.setup)}`, true);
        return;
      }
      if (d.connected) {
        const mode = d.includePrivate ? "publiek + privé" : "alleen publiek";
        let msg = `Strava: ${d.athleteName || "gekoppeld"} (${mode})`;
        const ds = getSelectedDatasetId();
        if (ds) {
          msg += ds === ALL_DATASETS ? " · scope: hele database" : ` · dataset: ${ds}`;
        }
        if (d.needsReconnect) {
          msg += " · klik Ververs Strava-toestemming (privé) of Koppel opnieuw";
        }
        if (serverJobActive(d.activeSyncJob)) {
          msg += ` · ${formatServerJobLine(d.activeSyncJob)}`;
          startServerJobPolling();
        } else {
          stopServerJobPolling();
        }
        if (d.activeSyncJob?.status === "completed") {
          const ch = logbookChannelLabel(d.activeSyncJob.routeSource === "cpl");
          msg += ` · ${ch} · server · afgerond`;
          global.dispatchEvent(new CustomEvent("fietsklim-climb-log-changed"));
        }
        if (d.activeSyncJob?.status === "failed") {
          const ch = logbookChannelLabel(d.activeSyncJob.routeSource === "cpl");
          msg += ` · ${ch} · server · mislukt: ${d.activeSyncJob.error || "?"}`;
        }
        if (d.lastSyncSummary) {
          const s = d.lastSyncSummary;
          const kind = s.kind === "full" ? "volledige sync" : "proef";
          const scope = s.allDatasets ? "alle regio’s" : s.datasetId;
          msg += ` · laatste ${kind}: ${s.uniqueClimbs} klimmen / ${s.activitiesScanned} ritten (${scope})`;
          if (s.kind === "full" && s.completed === false && !serverJobActive(d.activeSyncJob)) {
            if (s.allDatasets && s.regionProgress) msg += ` · ${s.regionProgress}`;
            if (s.source === "cpl") {
              if (s.activitiesWithMap != null) msg += ` · ${s.activitiesWithMap} ritten met route`;
              if (s.dateQueryIndexRequired) {
                msg += " · datumbereik: Firestore-index ownerId+date nodig in CPL";
              }
            } else if (s.nextPage) msg += ` · Strava pag. ${s.nextPage}`;
          }
        } else if (d.lastSyncAt) {
          msg += ` · sync ${new Date(d.lastSyncAt).toLocaleString("nl-NL")}`;
        }
        setStatus(msg);
        maybeResumeFullSync(d);
      } else {
        let msg = "Strava API: niet gekoppeld";
        if (fullDatabaseUsesCplRoutes()) {
          msg += " · hele database kan via CPL-server (knop hierboven)";
        }
        msg += setupHint(d.setup);
        setStatus(msg, !d.setup?.backendConfigured);
        updateSyncButtonsVisibility(false);
        renderCplSyncRunPanel();
      }
      renderStravaMatchPanels();
    } catch (e) {
      const msg = formatCallableError(e);
      setStatus(msg, true);
      if (/not-found|404|UNIMPLEMENTED/i.test(msg)) {
        setStatus(
          msg +
            " → Deploy workflow “Deploy Climbfinder import function” (bevat Strava-callables).",
          true
        );
      }
    }
  }

  function settingsReturnUrl() {
    const fromCfg = cfg().strava?.settingsUrl;
    if (fromCfg) return fromCfg;
    return new URL("settings.html", global.location.href).href;
  }

  async function connect() {
    setStatus("Strava-authorisatie voorbereiden…");
    try {
      const res = await callable("getStravaConnectUrl")({
        returnUrl: settingsReturnUrl(),
        includePrivate: includePrivateChecked(),
      });
      const url = res.data?.url;
      if (!url) {
        setStatus("Geen Strava-URL van server — controleer Functions-config.", true);
        return;
      }
      setStatus("Doorverwijzen naar Strava…");
      global.location.assign(url);
    } catch (e) {
      const msg = formatCallableError(e);
      setStatus(msg, true);
      if (/failed-precondition|client_id|redirect_uri/i.test(msg)) {
        setStatus(msg + " Zie docs/auth/STRAVA.md.", true);
      }
    }
  }

  async function disconnect() {
    if (!confirm("Strava loskoppelen? Tokens worden verwijderd.")) return;
    await callable("stravaDisconnect")({});
    await refreshStatus();
  }

  async function runTrialSync(options = {}) {
    const requireDateRange = Boolean(options.requireDateRange);
    const datasetId = getSelectedDatasetId();
    if (!datasetId) {
      setStatus("Kies eerst een regio-dataset.", true);
      return;
    }
    const btn =
      (requireDateRange ? $("stravaPeriodSyncBtn") : $("stravaTrialSyncBtn")) ||
      $("stravaTrialSyncBtn");
    if (btn) btn.disabled = true;
    const dateBounds = getSyncDateBoundsPayload();
    if (dateBounds.error) {
      setStatus(dateBounds.error, true);
      if (btn) btn.disabled = false;
      return;
    }
    const hasRange = dateBounds.payload.after != null || dateBounds.payload.before != null;
    if (requireDateRange && !hasRange) {
      setStatus("Strava API · browser: vul Ritdatum van en/of tot in.", true);
      if (btn) btn.disabled = false;
      return;
    }
    if (!requireDateRange && hasRange) {
      setStatus("Strava API · browser: gebruik datumbereik-knop of wis de datums voor 50 ritten.", true);
      if (btn) btn.disabled = false;
      return;
    }
    const scopeLabel = datasetId === ALL_DATASETS ? "hele database" : datasetId;
    setStatus(
      hasRange
        ? `Strava API · browser · datumbereik · ${scopeLabel}…`
        : `Strava API · browser · ${DEFAULT_PER_PAGE} ritten · ${scopeLabel}…`
    );
    try {
      const res = await callable("stravaSyncTrial")({
        datasetId,
        perPage: DEFAULT_PER_PAGE,
        ...dateBounds.payload,
      });
      setStatus(res.data?.message || "Klaar.");
      global.dispatchEvent(new CustomEvent("fietsklim-climb-log-changed"));
    } catch (e) {
      setStatus(formatCallableError(e), true);
    } finally {
      if (btn) btn.disabled = false;
      await refreshStatus();
    }
  }

  async function trialSync() {
    return runTrialSync({ requireDateRange: false });
  }

  async function periodSync() {
    return runTrialSync({ requireDateRange: true });
  }

  async function cleanupLogMatches() {
    if (
      !confirm(
        "Strava-koppelingen opschonen?\n\n• Indoor/Zwift/FulGaz wordt losgekoppeld\n• Buitenritten die de klim niet echt volgen (strikte route-check) ook\n\nGedaan-vinkjes die alleen via die Strava-match kwamen, gaan uit."
      )
    ) {
      return;
    }
    const btn = $("stravaCleanupBtn");
    if (btn) btn.disabled = true;
    setStatus("Strava-koppelingen controleren (ritten ophalen)…");
    try {
      const res = await callable("stravaCleanupLogMatches")({
        removeIndoor: true,
        revalidateRoutes: true,
      });
      setStatus(res.data?.message || "Opschoning klaar.");
      global.dispatchEvent(new CustomEvent("fietsklim-climb-log-changed"));
    } catch (e) {
      const msg = formatCallableError(e);
      setStatus(
        /not-found|UNIMPLEMENTED/i.test(msg)
          ? `${msg} → Deploy workflow met stravaCleanupLogMatches.`
          : msg,
        true
      );
    } finally {
      if (btn) btn.disabled = false;
      await refreshStatus();
    }
  }

  async function fullSyncServer() {
    const datasetId = getSelectedDatasetId();
    if (!datasetId) {
      setStatus("Kies eerst een regio-dataset.", true);
      return;
    }
    if (statusCache?.needsReconnect && includePrivateChecked()) {
      setStatus("Koppel Strava eerst opnieuw voor privé-activiteiten.", true);
      return;
    }
    if (serverJobActive(statusCache?.activeSyncJob)) {
      setStatus("Server-sync loopt al — status wordt ververst.", false);
      startServerJobPolling();
      return;
    }
    const dateBounds = getSyncDateBoundsPayload();
    if (dateBounds.error) {
      setStatus(dateBounds.error, true);
      return;
    }
    const serverBtn = $("stravaServerFullSyncBtn");
    const fullBtn = $("stravaFullSyncBtn");
    if (serverBtn) serverBtn.disabled = true;
    if (fullBtn) fullBtn.disabled = true;
    const viaCpl = datasetId === ALL_DATASETS && fullDatabaseUsesCplRoutes();
    const channel = logbookChannelLabel(viaCpl);
    setStatus(`${channel} · server wordt gestart… (tab mag dicht)`);
    try {
      const enqueueName =
        viaCpl && !statusCache?.routeSync?.fullDatabaseUsesCpl
          ? "cplEnqueueFullSync"
          : "stravaEnqueueFullSync";
      const res = await callable(enqueueName)({
        datasetId: viaCpl ? ALL_DATASETS : datasetId,
        ...dateBounds.payload,
      });
      setStatus(res.data?.message || `${channel} · server-job gestart.`);
      const panel = $("logbookCplRunPanel");
      if (panel) panel.hidden = false;
      const hl = $("logbookCplRunHeadline");
      if (hl) hl.textContent = `${channel} · server-job in wachtrij…`;
      startServerJobPolling();
      await refreshStatus();
    } catch (e) {
      const msg = formatCallableError(e);
      setStatus(
        /not-found|UNIMPLEMENTED/i.test(msg)
          ? `${msg} → Deploy workflow met stravaEnqueueFullSync / stravaSyncWorkerHttp.`
          : msg,
        true
      );
    } finally {
      updateSyncButtonsVisibility(statusCache?.connected);
    }
  }

  async function cancelServerSync() {
    const job = statusCache?.activeSyncJob;
    if (!job?.id) return;
    const btn = $("stravaCancelServerSyncBtn");
    if (btn) btn.disabled = true;
    const cancelFn =
      statusCache?.activeCplSyncJob?.id === job.id ? "cplCancelSyncJob" : "stravaCancelSyncJob";
    try {
      const res = await callable(cancelFn)({ jobId: job.id });
      setStatus(res.data?.message || "Server-sync geannuleerd.");
      stopServerJobPolling();
      await refreshStatus();
    } catch (e) {
      setStatus(formatCallableError(e), true);
    } finally {
      if (btn) btn.disabled = false;
      updateSyncButtonsVisibility(statusCache?.connected);
    }
  }

  async function fullSync(options = {}) {
    if (!options.resumeFromCheckpoint && useBackgroundFullSync()) {
      return fullSyncServer();
    }
    const resumeFromCheckpoint = Boolean(options.resumeFromCheckpoint);
    const datasetId = getSelectedDatasetId();
    if (!datasetId) {
      setStatus("Kies eerst een regio-dataset.", true);
      return;
    }
    if (!options.resumeFromCheckpoint && datasetId === ALL_DATASETS && fullDatabaseUsesCplRoutes()) {
      return fullSyncServer();
    }
    if (statusCache?.needsReconnect && includePrivateChecked()) {
      setStatus("Koppel Strava eerst opnieuw voor privé-activiteiten.", true);
      return;
    }
    if (fullSyncRunning) return;
    fullSyncRunning = true;

    const btn = $("stravaFullSyncBtn");
    const trialBtn = $("stravaTrialSyncBtn");
    if (btn) btn.disabled = true;
    if (trialBtn) trialBtn.disabled = true;

    const isAll = datasetId === ALL_DATASETS;
    const maxLoops = isAll ? FULL_SYNC_MAX_LOOPS_ALL : FULL_SYNC_MAX_LOOPS;
    let loops = 0;
    let reset = !resumeFromCheckpoint;
    let syncFailed = false;
    const dateBounds = getSyncDateBoundsPayload();
    if (dateBounds.error) {
      setStatus(dateBounds.error, true);
      fullSyncRunning = false;
      if (btn) btn.disabled = false;
      if (trialBtn) trialBtn.disabled = false;
      return;
    }

    if (!resumeFromCheckpoint) {
      sessionStorage.setItem(FULL_SYNC_WANTED_KEY, datasetId);
    }
    await acquireWakeLock();
    try {
      while (loops < maxLoops) {
        loops += 1;
        const scopeLabel = isAll ? "hele database" : datasetId;
        setStatus(
          `Strava API · browser · stap ${loops} · ${scopeLabel} (tab open houden)`,
          false
        );
        let res;
        try {
          res = await callable("stravaSyncFull")({
            datasetId,
            reset,
            ...dateBounds.payload,
          });
        } catch (batchErr) {
          syncFailed = true;
          const errText = formatCallableError(batchErr);
          setStatus(`Strava API · browser · stap ${loops} mislukt: ${errText}`, true);
          break;
        }
        reset = false;
        const data = res.data || {};
        setStatus(data.message || "Batch klaar.", false);
        global.dispatchEvent(new CustomEvent("fietsklim-climb-log-changed"));
        if (data.completed) {
          sessionStorage.removeItem(FULL_SYNC_WANTED_KEY);
          break;
        }
        if (!isAll && !data.nextPage) break;
      }
      if (!syncFailed && loops >= maxLoops) {
        setStatus(
          "Sync gestopt na maximum stappen — klik opnieuw Volledige history sync (loopt verder waar gebleven).",
          true
        );
      }
    } catch (e) {
      syncFailed = true;
      setStatus(formatCallableError(e), true);
    } finally {
      releaseWakeLock();
      fullSyncRunning = false;
      if (btn) btn.disabled = false;
      if (trialBtn) trialBtn.disabled = false;
      if (!syncFailed) {
        await refreshStatus();
      } else {
        updateSyncButtonsVisibility(statusCache?.connected);
        renderStravaMatchPanels();
      }
    }
  }

  function handleQueryParams() {
    const p = new URLSearchParams(global.location.search);
    const s = p.get("strava");
    if (!s) return;
    const msgs = {
      connected: "Strava gekoppeld.",
      denied: "Strava-toegang geweigerd.",
      token_error: "Strava-token mislukt — controleer redirect_uri in Strava-app en Functions config.",
      error: "Strava-koppeling mislukt (callback).",
    };
    if (msgs[s]) setStatus(msgs[s], s !== "connected");
    p.delete("strava");
    const q = p.toString();
    const url = global.location.pathname + (q ? `?${q}` : "") + global.location.hash;
    global.history.replaceState({}, "", url);
  }

  function init() {
    handleQueryParams();
    void populateDatasetSelect().then(() => refreshStatus());
    $("stravaDatasetSelect")?.addEventListener("change", function () {
      setStoredDatasetId(this.value);
      void refreshStatus();
    });
    $("stravaIncludePrivate")?.addEventListener("change", () => {
      schedulePrefsSave();
    });
    $("stravaConnectBtn")?.addEventListener("click", () => void connect());
    $("stravaReconnectBtn")?.addEventListener("click", () => void connect());
    $("stravaDisconnectBtn")?.addEventListener("click", () =>
      void disconnect().catch((e) => setStatus(formatCallableError(e), true))
    );
    $("stravaPeriodSyncBtn")?.addEventListener("click", () => void periodSync());
    $("stravaTrialSyncBtn")?.addEventListener("click", () => void trialSync());
    $("stravaFullSyncBtn")?.addEventListener("click", () => void fullSync());
    $("stravaServerFullSyncBtn")?.addEventListener("click", () => void fullSyncServer());
    $("stravaCancelServerSyncBtn")?.addEventListener("click", () => void cancelServerSync());
    const onDateRangeInput = () => updateSyncButtonsVisibility(Boolean(statusCache?.connected));
    $("stravaSyncDateFrom")?.addEventListener("change", onDateRangeInput);
    $("stravaSyncDateFrom")?.addEventListener("input", onDateRangeInput);
    $("stravaSyncDateTo")?.addEventListener("change", onDateRangeInput);
    $("stravaSyncDateTo")?.addEventListener("input", onDateRangeInput);
    $("stravaCleanupBtn")?.addEventListener("click", () => void cleanupLogMatches());
    global.addEventListener("fietsklim-authenticated", () => {
      void populateDatasetSelect().then(() => refreshStatus());
    });
    global.addEventListener("fietsklim-climb-log-changed", () => {
      renderStravaMatchPanels();
    });
    if (global.__FIETSKLIM_AUTH_READY) {
      void populateDatasetSelect().then(() => refreshStatus());
    }
    focusStravaSettingsFromHash();
    global.addEventListener("hashchange", focusStravaSettingsFromHash);
    global.document?.addEventListener?.("visibilitychange", () => {
      if (global.document.visibilityState === "visible" && fullSyncRunning) {
        void acquireWakeLock();
      }
    });
  }

  global.FietsKlimStravaSync = { init, refreshStatus, populateDatasetSelect };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
