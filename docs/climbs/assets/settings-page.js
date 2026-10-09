/** Instellingen-pagina: logboek-modus e.d. */
(function (global) {
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

  function init() {
    updateLogbookHint();
    global.addEventListener("fietsklim-authenticated", updateLogbookHint);
    if (global.__FIETSKLIM_AUTH_READY) updateLogbookHint();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
