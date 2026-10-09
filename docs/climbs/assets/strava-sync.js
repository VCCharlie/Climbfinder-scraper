/** Strava koppelen + proef-sync (Fase A/B). */
(function (global) {
  function cfg() {
    return global.FIETSKLIM_AUTH_CONFIG || {};
  }

  function fnRegion() {
    return cfg().githubImport?.region || "europe-west1";
  }

  function callable(name) {
    return firebase.app().functions(fnRegion()).httpsCallable(name);
  }

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(text, isError) {
    const el = $("stravaSyncStatus");
    if (!el) return;
    el.textContent = text || "";
    el.style.color = isError ? "#b91c1c" : "#64748b";
  }

  async function refreshStatus() {
    if (typeof firebase === "undefined" || !firebase.auth?.().currentUser) {
      setStatus("Log in om Strava te koppelen.");
      return;
    }
    try {
      const res = await callable("getStravaStatus")({});
      const d = res.data || {};
      $("stravaConnectBtn")?.toggleAttribute("hidden", d.connected);
      $("stravaDisconnectBtn")?.toggleAttribute("hidden", !d.connected);
      $("stravaTrialSyncBtn")?.toggleAttribute("hidden", !d.connected);
      if (d.connected) {
        let msg = `Strava: ${d.athleteName || "gekoppeld"} (publieke ritten)`;
        if (d.lastSyncSummary) {
          const s = d.lastSyncSummary;
          msg += ` · laatste sync: ${s.uniqueClimbs} klimmen / ${s.activitiesScanned} ritten (${s.datasetId})`;
        } else if (d.lastSyncAt) {
          msg += ` · sync ${new Date(d.lastSyncAt).toLocaleString("nl-NL")}`;
        }
        setStatus(msg);
      } else {
        setStatus("Strava niet gekoppeld — alleen publieke fietsritten worden gelezen.");
      }
    } catch (e) {
      setStatus(e.message || String(e), true);
    }
  }

  async function connect() {
    setStatus("Redirect naar Strava…");
    const res = await callable("getStravaConnectUrl")({});
    if (res.data?.url) {
      global.location.href = res.data.url;
    }
  }

  async function disconnect() {
    if (!confirm("Strava loskoppelen? Tokens worden verwijderd.")) return;
    await callable("stravaDisconnect")({});
    await refreshStatus();
  }

  async function trialSync() {
    const btn = $("stravaTrialSyncBtn");
    if (btn) btn.disabled = true;
    setStatus("Proef-sync: laatste 50 publieke ritten vs Zuid-Limburg…");
    try {
      const res = await callable("stravaSyncTrial")({ datasetId: "nl-limburg", perPage: 50 });
      setStatus(res.data?.message || "Klaar.");
      global.dispatchEvent(new CustomEvent("fietsklim-climb-log-changed"));
    } catch (e) {
      setStatus(e.message || String(e), true);
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
      token_error: "Strava-token mislukt — probeer opnieuw.",
      error: "Strava-koppeling mislukt.",
    };
    if (msgs[s]) setStatus(msgs[s], s !== "connected");
    p.delete("strava");
    const q = p.toString();
    const url = global.location.pathname + (q ? `?${q}` : "") + global.location.hash;
    global.history.replaceState({}, "", url);
  }

  function init() {
    handleQueryParams();
    $("stravaConnectBtn")?.addEventListener("click", () => void connect().catch((e) => setStatus(e.message, true)));
    $("stravaDisconnectBtn")?.addEventListener("click", () => void disconnect().catch((e) => setStatus(e.message, true)));
    $("stravaTrialSyncBtn")?.addEventListener("click", () => void trialSync());
    global.addEventListener("fietsklim-authenticated", () => void refreshStatus());
    if (global.__FIETSKLIM_AUTH_READY) void refreshStatus();
  }

  global.FietsKlimStravaSync = { init, refreshStatus };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
