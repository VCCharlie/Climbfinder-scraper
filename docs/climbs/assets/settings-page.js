/** Instellingen: logboek-sync (local / Firestore), export/import. */
(function (global) {
  const log = global.FietsKlimClimbLog;

  function updateLogbookSyncUi() {
    const statusEl = document.getElementById("logbookSyncStatus");
    const countsEl = document.getElementById("logbookCounts");
    const toggle = document.getElementById("logbookFirestoreToggle");
    const exportBtn = document.getElementById("logbookExportBtn");

    if (toggle && log?.isFirestoreSyncRequested) {
      toggle.checked = log.isFirestoreSyncRequested();
    }

    if (!log?.syncStatusSummary) {
      if (statusEl) statusEl.textContent = "Sync: —";
      return;
    }

    const summary = log.syncStatusSummary();
    if (statusEl) {
      statusEl.textContent = summary.line;
      statusEl.classList.toggle("is-error", summary.requestedFirestore && !summary.ok);
    }
    if (countsEl) countsEl.hidden = true;

    if (exportBtn) exportBtn.disabled = !log.isReady?.();
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

  async function onFirestoreToggleChange() {
    const toggle = document.getElementById("logbookFirestoreToggle");
    if (!toggle || !log?.setFirestoreSyncRequested) return;
    log.setFirestoreSyncRequested(toggle.checked);
    if (log.teardown) log.teardown();
    await ensureLogReady();
    updateLogbookSyncUi();
    global.dispatchEvent(new CustomEvent("fietsklim-climb-log-changed"));
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
      setImportStatus("Logboek nog niet geladen.", true);
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
      setImportStatus(`Import: ${result.imported} bijgewerkt.`);
      updateLogbookSyncUi();
    } catch (e) {
      setImportStatus(e.message || "Import mislukt.", true);
    }
  }

  function wireLogbookUi() {
    document.getElementById("logbookFirestoreToggle")?.addEventListener("change", () => {
      void onFirestoreToggleChange();
    });
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
    await ensureLogReady();
    updateLogbookSyncUi();
    global.addEventListener("fietsklim-climb-log-changed", updateLogbookSyncUi);
  }

  function init() {
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
