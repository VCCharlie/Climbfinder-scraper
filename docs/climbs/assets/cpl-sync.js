/**
 * Climb Performance Lab server-sync (hele database, zelfde datumbereik als Strava).
 */
(function cplSyncModule(global) {
  const FN_REGION = "europe-west1";
  const ALL_DATASETS = "__all__";

  function $(id) {
    return document.getElementById(id);
  }

  function fnRegion() {
    return FN_REGION;
  }

  function callable(name) {
    if (typeof firebase === "undefined" || !firebase.app) {
      throw new Error("Firebase niet geladen.");
    }
    return firebase.app().functions(fnRegion()).httpsCallable(name);
  }

  function formatError(e) {
    const code = e?.code || "";
    const msg = e?.message || String(e);
    if (code && msg !== code && !msg.includes(code)) return `${msg} (${code})`;
    return msg || code || "Onbekende fout";
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
    const el = $("cplSyncStatus");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("is-error", Boolean(isError));
  }

  function jobActive(job) {
    return job && (job.status === "queued" || job.status === "running");
  }

  let pollTimer = null;
  let statusCache = null;

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function updateButtons() {
    const active = jobActive(statusCache?.activeSyncJob);
    const linked = Boolean(statusCache?.linked);
    const configured = Boolean(statusCache?.serverSyncConfigured);
    const startBtn = $("cplServerFullSyncBtn");
    const cancelBtn = $("cplCancelServerSyncBtn");
    if (startBtn) {
      startBtn.hidden = !linked || !configured;
      startBtn.disabled = active;
    }
    if (cancelBtn) {
      cancelBtn.hidden = !active;
    }
  }

  async function refreshStatus() {
    try {
      const res = await callable("getCplStatus")({});
      statusCache = res.data || {};
      updateButtons();
      const job = statusCache.activeSyncJob;
      if (job) {
        const p = job.progress || {};
        setStatus(
          `CPL server-sync: ${job.status} · ritten ${p.activitiesScanned ?? 0} · klimmen ${p.uniqueClimbs ?? 0}${job.lastMessage ? ` — ${job.lastMessage}` : ""}`,
          job.status === "failed"
        );
      } else if (!statusCache.linked) {
        setStatus(
          "Geen Performance Lab-account voor dit e-mailadres. Log daar eerst in met dezelfde Google-account.",
          false
        );
      } else {
        const sum = statusCache.lastSyncSummary;
        if (sum?.uniqueClimbs != null) {
          setStatus(
            `Laatste CPL-sync: ${sum.uniqueClimbs} klim(men) in laatste batch · ${sum.regionCount ?? "?"} regio’s.`,
            false
          );
        } else {
          setStatus("Performance Lab gekoppeld — klaar voor server-sync.", false);
        }
      }
      if (!jobActive(job)) stopPolling();
    } catch (e) {
      setStatus(formatError(e), true);
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => void refreshStatus(), 8000);
  }

  async function startFullSync() {
    if (jobActive(statusCache?.activeSyncJob)) {
      setStatus("CPL server-sync loopt al…", false);
      startPolling();
      return;
    }
    const dateBounds = getSyncDateBoundsPayload();
    if (dateBounds.error) {
      setStatus(dateBounds.error, true);
      return;
    }
    const btn = $("cplServerFullSyncBtn");
    if (btn) btn.disabled = true;
    setStatus("CPL server-sync starten (hele database)…");
    try {
      const res = await callable("cplEnqueueFullSync")({
        datasetId: ALL_DATASETS,
        ...dateBounds.payload,
      });
      setStatus(res.data?.message || "CPL server-sync gestart.");
      startPolling();
      await refreshStatus();
    } catch (e) {
      setStatus(formatError(e), true);
    } finally {
      updateButtons();
    }
  }

  async function cancelSync() {
    const job = statusCache?.activeSyncJob;
    if (!job?.id) return;
    try {
      const res = await callable("cplCancelSyncJob")({ jobId: job.id });
      setStatus(res.data?.message || "Geannuleerd.");
      stopPolling();
      await refreshStatus();
    } catch (e) {
      setStatus(formatError(e), true);
    }
  }

  function init() {
    $("cplServerFullSyncBtn")?.addEventListener("click", () => void startFullSync());
    $("cplCancelServerSyncBtn")?.addEventListener("click", () => void cancelSync());
    global.addEventListener("fietsklim-auth-ready", () => void refreshStatus());
    if (global.FietsKlimAuth?.isSignedIn?.()) void refreshStatus();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
