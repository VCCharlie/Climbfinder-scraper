/**
 * Activity feed: client-side log + GitHub Actions run polling via Firebase Callable.
 */
(function (global) {
  /** @type {Array<{id:string,label:string,workflowFile:string,dispatchedAtMs:number,runId?:number,status?:string,displayStatus?:string,htmlUrl?:string}>} */
  let jobs = [];
  let pollTimer = null;

  function cfg() {
    return global.FIETSKLIM_AUTH_CONFIG?.githubImport;
  }

  function callable(name) {
    const c = cfg();
    if (!c?.enabled || typeof firebase === "undefined" || !firebase.app) return null;
    return firebase.app().functions(c.region || "europe-west1").httpsCallable(name);
  }

  function el(id) {
    return document.getElementById(id);
  }

  function statusLabel(job) {
    if (!job) return "Geen actieve taken";
    if (job.displayStatus) return job.displayStatus;
    if (job.status === "completed") return "Afgerond";
    return "Gestart…";
  }

  function render() {
    const statusEl = el("workflowActivityStatus");
    const listEl = el("workflowActivityList");
    if (!statusEl || !listEl) return;

    const active = jobs.filter((j) => j.status !== "completed" || j.conclusion === null);
    const latest = jobs[0] || null;
    const show = latest && (latest.status !== "completed" || Date.now() - latest.dispatchedAtMs < 120_000);

    if (!show) {
      statusEl.textContent = "Geen actieve workflow";
      statusEl.className = "activity-status activity-status--idle";
      listEl.innerHTML = "";
      return;
    }

    statusEl.textContent = `${latest.label}: ${statusLabel(latest)}`;
    statusEl.className =
      "activity-status " +
      (latest.conclusion === "failure"
        ? "activity-status--error"
        : latest.status === "completed"
          ? "activity-status--ok"
          : "activity-status--busy");

    listEl.innerHTML = jobs
      .slice(0, 6)
      .map((j) => {
        const link = j.htmlUrl
          ? `<a href="${j.htmlUrl}" target="_blank" rel="noopener">GitHub-run</a>`
          : "";
        return `<li><strong>${j.label}</strong> — ${statusLabel(j)} ${link}</li>`;
      })
      .join("");
  }

  async function pollOnce() {
    const fn = callable("getGithubWorkflowRunStatus");
    if (!fn) return;

    let changed = false;
    for (const job of jobs) {
      if (job.status === "completed" && job.conclusion) continue;
      try {
        const payload = job.runId
          ? { run_id: job.runId }
          : { workflow_file: job.workflowFile, since_ms: job.dispatchedAtMs };
        const res = await fn(payload);
        const d = res.data || {};
        if (!d.found && !d.run_id) continue;
        if (d.run_id) job.runId = d.run_id;
        job.status = d.status;
        job.conclusion = d.conclusion;
        job.displayStatus = d.display_status;
        job.htmlUrl = d.html_url;
        const prevStatus = job._lastPolledStatus;
        job._lastPolledStatus = job.status;
        if (
          job.status === "completed" &&
          job.conclusion === "success" &&
          prevStatus !== "completed" &&
          !job.completionNotified
        ) {
          job.completionNotified = true;
          global.dispatchEvent(
            new CustomEvent("fietsklim-workflow-complete", {
              detail: {
                workflowFile: job.workflowFile,
                label: job.label,
              },
            })
          );
        }
        changed = true;
      } catch {
        /* volgende poll */
      }
    }
    if (changed) render();
  }

  function ensurePoll() {
    if (pollTimer) return;
    pollTimer = setInterval(() => void pollOnce(), 12_000);
    void pollOnce();
  }

  /**
   * @param {object} opts
   * @param {string} opts.label
   * @param {string} opts.workflowFile
   * @param {number} [opts.dispatchedAtMs]
   * @param {(msg:string)=>void} [opts.log]
   */
  function trackWorkflow(opts) {
    const job = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      label: opts.label,
      workflowFile: opts.workflowFile,
      dispatchedAtMs: opts.dispatchedAtMs || Date.now(),
      status: "queued",
      displayStatus: "Workflow gestart…",
    };
    jobs.unshift(job);
    if (jobs.length > 12) jobs.length = 12;
    render();
    ensurePoll();
    opts.log?.(`${job.label}: workflow gestart — status wordt live bijgewerkt.`);
    return job;
  }

  /** Na Firebase dispatch-response (bevat workflowFile + dispatchedAtMs). */
  function trackDispatchResponse(label, data, log) {
    if (!data?.workflowFile) {
      trackWorkflow({ label, workflowFile: "unknown.yml", log });
      return;
    }
    trackWorkflow({
      label,
      workflowFile: data.workflowFile,
      dispatchedAtMs: data.dispatchedAtMs,
      log,
    });
  }

  global.FietsKlimActivityFeed = {
    trackWorkflow,
    trackDispatchResponse,
    render,
    pollOnce,
  };
})(typeof window !== "undefined" ? window : globalThis);
