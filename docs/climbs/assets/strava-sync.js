/** Strava koppelen + proef-sync (dataset uit index.json). */
(function (global) {
  const DATASET_STORAGE_KEY = "fietsklim-strava-dataset-id";
  const DEFAULT_PER_PAGE = 50;

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
    return " Server: strava.client_id/secret/redirect_uri nog niet gezet — functions:config:set + Deploy Functions.";
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
      sel.innerHTML = '<option value="">— kies regio-dataset —</option>';
      for (const r of regions) {
        const opt = document.createElement("option");
        opt.value = r.id;
        opt.textContent = `${r.displayTitle || r.title || r.id} (${r.count ?? 0})`;
        sel.appendChild(opt);
      }
      const stored = getStoredDatasetId();
      const cfgDefault = cfg().strava?.defaultDatasetId;
      const pick = stored || cfgDefault || "";
      if (pick && regions.some((r) => r.id === pick)) {
        sel.value = pick;
      }
      sel.disabled = false;
    } catch (e) {
      sel.innerHTML = `<option value="">Fout: ${e.message}</option>`;
    }
  }

  function updateTrialSyncVisibility(connected) {
    const btn = $("stravaTrialSyncBtn");
    const sel = $("stravaDatasetSelect");
    if (!btn) return;
    const datasetOk = Boolean(getSelectedDatasetId());
    const show = connected && datasetOk;
    btn.toggleAttribute("hidden", !show);
    btn.disabled = !show;
    if (sel) sel.toggleAttribute("hidden", !connected);
  }

  async function refreshStatus() {
    if (typeof firebase === "undefined" || !firebase.auth?.().currentUser) {
      setStatus("Log in om Strava te koppelen.");
      updateTrialSyncVisibility(false);
      return;
    }
    try {
      const res = await callable("getStravaStatus")({});
      const d = res.data || {};
      $("stravaConnectBtn")?.toggleAttribute("hidden", d.connected);
      $("stravaDisconnectBtn")?.toggleAttribute("hidden", !d.connected);
      updateTrialSyncVisibility(d.connected);
      if (d.firestoreError) {
        setStatus(`Firestore-fout: ${d.hint || "?"}${setupHint(d.setup)}`, true);
        return;
      }
      if (d.connected) {
        let msg = `Strava: ${d.athleteName || "gekoppeld"} (publieke ritten)`;
        const ds = getSelectedDatasetId();
        if (ds) msg += ` · dataset: ${ds}`;
        if (d.lastSyncSummary) {
          const s = d.lastSyncSummary;
          msg += ` · laatste sync: ${s.uniqueClimbs} klimmen / ${s.activitiesScanned} ritten (${s.datasetId})`;
        } else if (d.lastSyncAt) {
          msg += ` · sync ${new Date(d.lastSyncAt).toLocaleString("nl-NL")}`;
        }
        setStatus(msg);
      } else {
        setStatus(
          "Strava niet gekoppeld — alleen publieke fietsritten." + setupHint(d.setup),
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

  async function connect() {
    setStatus("Strava-authorisatie voorbereiden…");
    try {
      const res = await callable("getStravaConnectUrl")({});
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
      setStatus("Kies eerst een regio-dataset voor proef-sync.", true);
      return;
    }
    const btn = $("stravaTrialSyncBtn");
    if (btn) btn.disabled = true;
    setStatus(`Proef-sync: laatste ${DEFAULT_PER_PAGE} publieke ritten vs ${datasetId}…`);
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
    $("stravaConnectBtn")?.addEventListener("click", () => void connect());
    $("stravaDisconnectBtn")?.addEventListener("click", () => void disconnect().catch((e) => setStatus(formatCallableError(e), true)));
    $("stravaTrialSyncBtn")?.addEventListener("click", () => void trialSync());
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
