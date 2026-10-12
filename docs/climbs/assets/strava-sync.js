/** Strava koppelen, voorkeuren (privé), proef- en volledige sync. */
(function (global) {
  const DATASET_STORAGE_KEY = "fietsklim-strava-dataset-id";
  const INCLUDE_PRIVATE_STORAGE_KEY = "fietsklim-strava-include-private";
  const ALL_DATASETS = "__all__";
  const DEFAULT_PER_PAGE = 50;
  const FULL_SYNC_MAX_LOOPS = 80;
  const FULL_SYNC_MAX_LOOPS_ALL = 800;

  let statusCache = null;
  let prefsSaveTimer = null;

  function cfg() {
    return global.FIETSKLIM_AUTH_CONFIG || {};
  }

  function fnRegion() {
    return cfg().strava?.region || cfg().githubImport?.region || "europe-west1";
  }

  function formatCallableError(e) {
    if (!e) return "Onbekende fout";
    const code = e.code ? String(e.code).replace(/^functions\//, "") : "";
    const msg = e.message || String(e);
    if (code === "internal" && msg === "internal") {
      return "Interne serverfout — meestal: Strava Functions niet gedeployed of Firestore uit. Zie docs/auth/STRAVA.md.";
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

  function setStatus(text, isError) {
    const el = $("stravaSyncStatus");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("is-error", Boolean(isError));
    if (!el.classList.contains("settings-status")) {
      el.style.color = isError ? "#b91c1c" : "#64748b";
    }
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
      hint.textContent =
        "Privé staat aan, maar Strava heeft nog geen activity:read_all — klik Koppel Strava opnieuw (toestemming vernieuwen).";
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

  function updateSyncButtonsVisibility(connected) {
    const datasetOk = Boolean(getSelectedDatasetId());
    const trial = $("stravaTrialSyncBtn");
    const full = $("stravaFullSyncBtn");
    const show = connected && datasetOk;
    trial?.toggleAttribute("hidden", !show);
    full?.toggleAttribute("hidden", !show);
    if (trial) trial.disabled = !show;
    if (full) full.disabled = !show || Boolean(statusCache?.needsReconnect && includePrivateChecked());
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
      $("stravaConnectBtn")?.toggleAttribute("hidden", d.connected);
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
        if (d.lastSyncSummary) {
          const s = d.lastSyncSummary;
          const kind = s.kind === "full" ? "volledige sync" : "proef";
          const scope = s.allDatasets ? "alle regio’s" : s.datasetId;
          msg += ` · laatste ${kind}: ${s.uniqueClimbs} klimmen / ${s.activitiesScanned} ritten (${scope})`;
          if (s.kind === "full" && s.completed === false) {
            if (s.allDatasets && s.regionProgress) msg += ` · ${s.regionProgress}`;
            if (s.nextPage) msg += ` · Strava pag. ${s.nextPage}`;
          }
        } else if (d.lastSyncAt) {
          msg += ` · sync ${new Date(d.lastSyncAt).toLocaleString("nl-NL")}`;
        }
        setStatus(msg);
      } else {
        setStatus(
          "Strava niet gekoppeld." + setupHint(d.setup),
          !d.setup?.backendConfigured
        );
      }
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

  async function trialSync() {
    const datasetId = getSelectedDatasetId();
    if (!datasetId) {
      setStatus("Kies eerst een regio-dataset.", true);
      return;
    }
    const btn = $("stravaTrialSyncBtn");
    if (btn) btn.disabled = true;
    setStatus(`Proef-sync: laatste ${DEFAULT_PER_PAGE} ritten vs ${datasetId}…`);
    try {
      const res = await callable("stravaSyncTrial")({ datasetId, perPage: DEFAULT_PER_PAGE });
      setStatus(res.data?.message || "Klaar.");
      global.dispatchEvent(new CustomEvent("fietsklim-climb-log-changed"));
    } catch (e) {
      setStatus(formatCallableError(e), true);
    } finally {
      if (btn) btn.disabled = false;
      await refreshStatus();
    }
  }

  async function fullSync() {
    const datasetId = getSelectedDatasetId();
    if (!datasetId) {
      setStatus("Kies eerst een regio-dataset.", true);
      return;
    }
    if (statusCache?.needsReconnect && includePrivateChecked()) {
      setStatus("Koppel Strava eerst opnieuw voor privé-activiteiten.", true);
      return;
    }
    const btn = $("stravaFullSyncBtn");
    const trialBtn = $("stravaTrialSyncBtn");
    if (btn) btn.disabled = true;
    if (trialBtn) trialBtn.disabled = true;

    const isAll = datasetId === ALL_DATASETS;
    const maxLoops = isAll ? FULL_SYNC_MAX_LOOPS_ALL : FULL_SYNC_MAX_LOOPS;
    let loops = 0;
    let reset = true;
    try {
      while (loops < maxLoops) {
        loops += 1;
        const scopeLabel = isAll ? "hele database" : datasetId;
        setStatus(
          `Volledige sync (${scopeLabel}): stap ${loops}… (laat dit scherm open tot “klaar” verschijnt)`
        );
        const res = await callable("stravaSyncFull")({ datasetId, reset });
        reset = false;
        const data = res.data || {};
        setStatus(data.message || "Batch klaar.");
        global.dispatchEvent(new CustomEvent("fietsklim-climb-log-changed"));
        if (data.completed) break;
        if (!isAll && !data.nextPage) break;
      }
      if (loops >= maxLoops) {
        setStatus(
          "Sync gestopt na maximum stappen — klik opnieuw Volledige history sync (loopt verder waar gebleven).",
          true
        );
      }
    } catch (e) {
      setStatus(formatCallableError(e), true);
    } finally {
      if (btn) btn.disabled = false;
      if (trialBtn) trialBtn.disabled = false;
      await refreshStatus();
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
    $("stravaDisconnectBtn")?.addEventListener("click", () =>
      void disconnect().catch((e) => setStatus(formatCallableError(e), true))
    );
    $("stravaTrialSyncBtn")?.addEventListener("click", () => void trialSync());
    $("stravaFullSyncBtn")?.addEventListener("click", () => void fullSync());
    global.addEventListener("fietsklim-authenticated", () => {
      void populateDatasetSelect().then(() => refreshStatus());
    });
    if (global.__FIETSKLIM_AUTH_READY) {
      void populateDatasetSelect().then(() => refreshStatus());
    }
  }

  global.FietsKlimStravaSync = { init, refreshStatus, populateDatasetSelect };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
