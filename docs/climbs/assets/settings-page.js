/** Instellingen-pagina: logboek-modus, export/import. */
(function (global) {
  const log = global.FietsKlimClimbLog;

  function updateLogbookHint() {
    const el = document.getElementById("logbookModeHint");
    if (!el) return;
    const cfg = global.FIETSKLIM_AUTH_CONFIG || {};
    const useFs = cfg.climbLog?.useFirestore !== false;
    if (useFs) {
      el.textContent =
        "Config: Firestore aan. Vereist Native mode (niet Datastore mode) — zie rode Strava/Firestore-fout? Maak Firestore Native of zet useFirestore: false.";
    } else {
      el.textContent = "Config: localStorage — vinkjes alleen in deze browser.";
    }
  }

  function updateLogbookStats() {
    const stats = document.getElementById("logbookStats");
    const exportBtn = document.getElementById("logbookExportBtn");
    if (!log?.isReady?.()) {
      if (stats) stats.hidden = true;
      if (exportBtn) exportBtn.disabled = true;
      return;
    }
    const mode = log.getMode?.() || "?";
    const done = log.totalDone();
    const wish = log.totalWishlist();
    if (stats) {
      stats.hidden = false;
      stats.textContent = `Logboek geladen (${mode}): ${done} gedaan, ${wish} op wishlist.`;
    }
    if (exportBtn) exportBtn.disabled = false;
  }

  async function ensureLogReady() {
    if (!log) return false;
    if (log.isReady()) return true;
    try {
      await log.init();
    } catch (e) {
      console.warn("Logboek init:", e);
    }
    return log.isReady();
  }

  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function setImportStatus(msg, isError) {
    const el = document.getElementById("logbookImportStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("is-error", Boolean(isError));
  }

  async function onExport() {
    if (!(await ensureLogReady())) {
      setImportStatus("Logboek nog niet geladen — wacht een moment of herlaad.", true);
      return;
    }
    const payload = log.exportPayload();
    const stamp = new Date().toISOString().slice(0, 10);
    downloadJson(`fietsklim-logboek-${stamp}.json`, payload);
    setImportStatus(`Export: ${payload.entries.length} regel(s).`);
  }

  async function onImportFile(file) {
    if (!file) return;
    setImportStatus("Importeren…");
    if (!(await ensureLogReady())) {
      setImportStatus("Logboek niet beschikbaar.", true);
      return;
    }
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const result = await log.importPayload(data, { merge: true });
      setImportStatus(
        `Import klaar: ${result.imported} bijgewerkt, ${result.skipped} overgeslagen.`
      );
      updateLogbookStats();
    } catch (e) {
      setImportStatus(e.message || "Import mislukt.", true);
    }
  }

  function wireLogbookUi() {
    document.getElementById("logbookExportBtn")?.addEventListener("click", () => {
      onExport();
    });
    document.getElementById("logbookImportFile")?.addEventListener("change", (ev) => {
      const file = ev.target.files?.[0];
      ev.target.value = "";
      onImportFile(file);
    });
  }

  async function onAuthenticated() {
    updateLogbookHint();
    await ensureLogReady();
    updateLogbookStats();
    global.addEventListener("fietsklim-climb-log-changed", updateLogbookStats);
  }

  function init() {
    updateLogbookHint();
    wireLogbookUi();
    global.addEventListener("fietsklim-authenticated", () => {
      onAuthenticated();
    });
    if (global.__FIETSKLIM_AUTH_READY) onAuthenticated();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
