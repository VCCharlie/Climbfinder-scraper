/**
 * Phase 3 — Strava full sync via Cloud Tasks → Gen1 HTTP worker (parallel aan browser-loop).
 */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { CloudTasksClient } = require("@google-cloud/tasks");

const REGION = "europe-west1";
const TASK_QUEUE_ID = "strava-sync";
const JOB_COLLECTION = "stravaSyncJobs";
const ACTIVE_STATUSES = ["queued", "running"];
const BATCH_DELAY_SECONDS = 22;
/** Stop automatische 429-retries zonder voortgang (batchCount blijft 0). */
const MAX_RATE_LIMIT_RETRIES_WITHOUT_PROGRESS = 10;
const WORKER_SECRET_HEADER = "x-fietsklim-worker-secret";
/** Gen1 worker timeout (runWith) — jobs die langer op `running` blijven zijn vastgelopen. */
const WORKER_TIMEOUT_SECONDS = 300;
const RUNNING_STALE_MS = (WORKER_TIMEOUT_SECONDS + 120) * 1000;

function jobUpdatedAtMs(job) {
  if (!job) return 0;
  const u = job.updatedAt;
  if (u?.toMillis) return u.toMillis();
  if (typeof u === "string") {
    const t = Date.parse(u);
    if (Number.isFinite(t)) return t;
  }
  if (typeof u === "number" && Number.isFinite(u)) return u;
  return 0;
}

function isStaleRunningJob(job, nowMs = Date.now()) {
  if (!job || job.status !== "running") return false;
  const updated = jobUpdatedAtMs(job);
  if (!updated) return true;
  return nowMs - updated > RUNNING_STALE_MS;
}

function staleRunningErrorMessage(job) {
  const updated = jobUpdatedAtMs(job);
  const ageMin = updated ? Math.max(1, Math.round((Date.now() - updated) / 60_000)) : null;
  const agePart = ageMin != null ? `${ageMin} min` : "onbekende duur";
  return (
    `Server-sync hing vast op 'running' (${agePart}). ` +
    "Waarschijnlijk time-out of crash in stravaSyncWorkerHttp — zie Firebase Logs (stravaSyncWorker / stravaSyncWorker batch). " +
    "Annuleer of wacht tot deze melding verschijnt, start daarna opnieuw (cursor in Strava-integratie blijft behouden)."
  );
}

function syncJobDiagnostics(job) {
  if (!job) return null;
  const updated = jobUpdatedAtMs(job);
  const stale = isStaleRunningJob(job);
  const hints = [];
  if (job.status === "running" && !stale) {
    hints.push(
      "Worker is actief of wacht op Strava/dataset-matching. Bij hele database duurt batch 1 soms enkele minuten (max ~5 min Functions-timeout)."
    );
  }
  if (stale) {
    hints.push(staleRunningErrorMessage(job));
    hints.push(
      "Cloud Console → Logging: filter resource.labels.function_name=stravaSyncWorkerHttp AND severity>=ERROR."
    );
    hints.push(
      "Cloud Tasks → queue strava-sync (europe-west1): mislukte taken tonen HTTP-status (403=worker_secret, 5xx=batch-crash)."
    );
  }
  if (job.status === "queued" && updated && Date.now() - updated > 10 * 60_000) {
    hints.push(
      "Job blijft lang 'queued' — worker-task wordt niet uitgevoerd (queue, IAM Enqueuer, of verkeerde worker-URL)."
    );
  }
  return {
    runningAgeMs: updated ? Date.now() - updated : null,
    staleRunning: stale,
    workerTimeoutSeconds: WORKER_TIMEOUT_SECONDS,
    hints,
  };
}

function stravaCfg() {
  return functions.config().strava || {};
}

function projectId() {
  return process.env.GCLOUD_PROJECT || admin.app().options.projectId || "climb-database";
}

function workerUrl() {
  const custom = stravaCfg().worker_url;
  if (custom && String(custom).trim()) return String(custom).trim();
  return `https://${REGION}-${projectId()}.cloudfunctions.net/stravaSyncWorkerHttp`;
}

function jobsCol(uid) {
  return admin.firestore().collection("users").doc(uid).collection(JOB_COLLECTION);
}

function jobRef(uid, jobId) {
  return jobsCol(uid).doc(jobId);
}

function publicJobView(doc) {
  if (!doc) return null;
  const d = doc.data ? doc.data() : doc;
  const id = doc.id || d.id;
  if (!id || !d) return null;
  return {
    id,
    status: d.status,
    datasetId: d.datasetId,
    routeSource: "strava",
    error: d.error || null,
    createdAt: d.createdAt?.toDate?.()?.toISOString?.() || null,
    updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() || null,
    progress: d.progress || null,
    after: d.afterMs ?? null,
    before: d.beforeMs ?? null,
    batchCount: d.batchCount ?? 0,
    lastMessage: d.lastMessage || null,
  };
}

async function reconcileStaleRunningJob(uid, docSnap) {
  const data = docSnap.data();
  if (!isStaleRunningJob(data)) return docSnap;
  const msg = staleRunningErrorMessage(data);
  functions.logger.warn("stravaSyncJob stale running → failed", { uid, jobId: docSnap.id, msg });
  await jobRef(uid, docSnap.id).set(
    {
      status: "failed",
      error: msg.slice(0, 500),
      lastMessage: "Automatisch afgebroken (stale lease).",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  const refreshed = await jobRef(uid, docSnap.id).get();
  return refreshed;
}

async function getActiveSyncJob(uid) {
  const snap = await jobsCol(uid).where("status", "in", ACTIVE_STATUSES).limit(10).get();
  if (snap.empty) return null;
  let best = snap.docs[0];
  let bestMs = best.data().createdAt?.toMillis?.() || 0;
  for (const doc of snap.docs) {
    const ms = doc.data().createdAt?.toMillis?.() || 0;
    if (ms >= bestMs) {
      best = doc;
      bestMs = ms;
    }
  }
  if (best.data().status === "running") {
    best = await reconcileStaleRunningJob(uid, best);
  }
  const status = best.data().status;
  if (status !== "queued" && status !== "running") {
    return null;
  }
  return publicJobView(best);
}

function requireAuth(context) {
  const cfg = functions.config().auth || {};
  const list = (cfg.allowed_emails || "vr.deruiter@gmail.com")
    .split(",")
    .map((s) => s.trim().toLowerCase());
  if (!context.auth?.token?.email) {
    throw new functions.https.HttpsError("unauthenticated", "Log in met Google.");
  }
  if (!list.includes(context.auth.token.email.trim().toLowerCase())) {
    throw new functions.https.HttpsError("permission-denied", "Geen toegang.");
  }
  return context.auth.uid;
}

function parseBounds(data) {
  const afterMs = data?.after != null && data.after !== "" ? Number(data.after) : null;
  const beforeMs = data?.before != null && data.before !== "" ? Number(data.before) : null;
  if (
    afterMs != null &&
    beforeMs != null &&
    Number.isFinite(afterMs) &&
    Number.isFinite(beforeMs) &&
    afterMs >= beforeMs
  ) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Datum ‘tot’ moet na ‘van’ liggen."
    );
  }
  return {
    afterMs: afterMs != null && Number.isFinite(afterMs) ? afterMs : null,
    beforeMs: beforeMs != null && Number.isFinite(beforeMs) ? beforeMs : null,
  };
}

function progressFromSummary(summary) {
  if (!summary) return {};
  return {
    activitiesScanned: summary.activitiesScanned ?? 0,
    uniqueClimbs: summary.uniqueClimbs ?? summary.matchesWritten ?? 0,
    stravaDetailReads: summary.stravaDetailReads ?? 0,
    nextPage: summary.nextPage ?? null,
    regionIndex: summary.nextDatasetIndex ?? 0,
    regionProgress: summary.regionProgress ?? null,
    completed: Boolean(summary.completed),
  };
}

let tasksClient;
function getTasksClient() {
  if (!tasksClient) tasksClient = new CloudTasksClient();
  return tasksClient;
}

function cloudTasksErrorMessage(err) {
  const code = err?.code ?? err?.status;
  const text = err?.message || String(err);
  if (code === 5 || /NOT_FOUND/i.test(text)) {
    return (
      `Cloud Tasks-queue "${TASK_QUEUE_ID}" ontbreekt in ${REGION}. ` +
      "Project owner: eenmalig queue aanmaken (Cloud Shell-commando in docs/auth/STRAVA.md)."
    );
  }
  if (code === 7 || /PERMISSION_DENIED/i.test(text)) {
    return (
      `Geen rechten om Cloud Tasks te plaatsen. ` +
      `IAM: ${projectId()}@appspot.gserviceaccount.com → rol Cloud Tasks Enqueuer.`
    );
  }
  if (/worker_secret/i.test(text)) {
    return text;
  }
  return `Server-sync task mislukt: ${text.slice(0, 300)}`;
}

async function enqueueWorkerTask(payload, delaySeconds = 0) {
  const secret = stravaCfg().worker_secret;
  if (!secret) {
    throw new Error(
      "strava.worker_secret ontbreekt — zet via deploy-workflow (STRAVA_WORKER_SECRET) of functions:config:set"
    );
  }
  const client = getTasksClient();
  const parent = client.queuePath(projectId(), REGION, TASK_QUEUE_ID);
  const scheduleTime =
    delaySeconds > 0
      ? { seconds: Math.floor(Date.now() / 1000) + delaySeconds }
      : undefined;
  const task = {
    httpRequest: {
      httpMethod: "POST",
      url: workerUrl(),
      headers: {
        "Content-Type": "application/json",
        [WORKER_SECRET_HEADER]: String(secret),
      },
      body: Buffer.from(JSON.stringify(payload)).toString("base64"),
    },
    scheduleTime,
  };
  try {
    await client.createTask({ parent, task });
  } catch (e) {
    functions.logger.error("enqueueWorkerTask", { parent, url: workerUrl(), err: e });
    const wrapped = new Error(cloudTasksErrorMessage(e));
    wrapped.cause = e;
    throw wrapped;
  }
}

async function markJobFailed(uid, jobId, message) {
  await jobRef(uid, jobId).set(
    {
      status: "failed",
      error: String(message || "Onbekende fout").slice(0, 500),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

exports.getActiveSyncJob = getActiveSyncJob;
exports.isStaleRunningJob = isStaleRunningJob;
exports.RUNNING_STALE_MS = RUNNING_STALE_MS;
exports.syncJobDiagnostics = syncJobDiagnostics;

exports.isBackgroundSyncConfigured = function isBackgroundSyncConfigured() {
  return Boolean(stravaCfg().worker_secret);
};

exports.stravaEnqueueFullSync = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 120, memory: "256MB" })
  .https.onCall(async (data, context) => {
    try {
      const uid = requireAuth(context);
      if (!stravaCfg().worker_secret) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Server-sync is nog niet geconfigureerd (strava.worker_secret). Draai Deploy Climbfinder import function opnieuw."
        );
      }
      const datasetId = String(data.datasetId || "").trim();
      if (!datasetId) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "datasetId is verplicht (regio-dataset of hele database)."
        );
      }

      const email = context.auth.token.email.trim();
      const {
        isAllDatasetsToken,
        preferFullDatabaseRouteSyncViaCpl,
      } = require("./routeSyncPolicy");

      const forceStravaApi = data?.forceStravaApi === true || data?.forceStravaApi === "true";
      if (
        !forceStravaApi &&
        isAllDatasetsToken(datasetId) &&
        (await preferFullDatabaseRouteSyncViaCpl(context))
      ) {
        const cplBg = require("./cplBackgroundSync");
        const { authIdentityFromContext } = require("./cplClient");
        return cplBg.enqueueFullSyncJob(uid, authIdentityFromContext(context), data);
      }

      const existing = await getActiveSyncJob(uid);
      if (existing) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          `Er loopt al een server-sync (${existing.status}). Wacht tot die klaar is of annuleer.`
        );
      }
      const cplActive = await require("./cplBackgroundSync").getActiveSyncJob(uid);
      if (cplActive) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          `Er loopt al een Performance Lab server-sync (${cplActive.status}). Wacht of annuleer die eerst.`
        );
      }

      const bounds = parseBounds(data);
      const jobId = admin.firestore().collection("_").doc().id;
      const now = admin.firestore.FieldValue.serverTimestamp();

      await jobRef(uid, jobId).set({
        status: "queued",
        datasetId,
        afterMs: bounds.afterMs,
        beforeMs: bounds.beforeMs,
        batchCount: 0,
        firstBatchPending: true,
        createdAt: now,
        updatedAt: now,
        error: null,
        progress: {
          activitiesScanned: 0,
          uniqueClimbs: 0,
          nextPage: 1,
          regionIndex: 0,
          completed: false,
        },
      });

      try {
        await enqueueWorkerTask({ uid, jobId }, 0);
      } catch (enqueueErr) {
        await jobRef(uid, jobId).delete().catch(() => {});
        throw new functions.https.HttpsError(
          "failed-precondition",
          enqueueErr.message || cloudTasksErrorMessage(enqueueErr)
        );
      }

      const created = await jobRef(uid, jobId).get();
      return {
        ok: true,
        jobId,
        message: "Server-sync gestart — je kunt dit tabblad sluiten. Status ververs op Instellingen.",
        job: publicJobView(created),
      };
    } catch (e) {
      if (e instanceof functions.https.HttpsError) throw e;
      functions.logger.error("stravaEnqueueFullSync", e);
      throw new functions.https.HttpsError(
        "failed-precondition",
        e.message || "Server-sync kon niet starten — zie Firebase Functions-logs (stravaEnqueueFullSync)."
      );
    }
  });

exports.getStravaSyncJob = functions.region(REGION).https.onCall(async (data, context) => {
  const uid = requireAuth(context);
  const jobId = String(data.jobId || "").trim();
  if (jobId) {
    let snap = await jobRef(uid, jobId).get();
    if (!snap.exists) {
      throw new functions.https.HttpsError("not-found", "Sync-job niet gevonden.");
    }
    if (snap.data().status === "running") {
      snap = await reconcileStaleRunningJob(uid, snap);
    }
    const job = publicJobView(snap);
    return { job, diagnostics: syncJobDiagnostics(snap.data()) };
  }
  const active = await getActiveSyncJob(uid);
  return {
    job: active,
    diagnostics: active ? syncJobDiagnostics({ ...active, updatedAt: active.updatedAt }) : null,
  };
});

exports.stravaCancelSyncJob = functions.region(REGION).https.onCall(async (data, context) => {
  const uid = requireAuth(context);
  const jobId = String(data.jobId || "").trim();
  if (!jobId) {
    throw new functions.https.HttpsError("invalid-argument", "jobId is verplicht.");
  }
  const ref = jobRef(uid, jobId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new functions.https.HttpsError("not-found", "Sync-job niet gevonden.");
  }
  const status = snap.data().status;
  if (status !== "queued" && status !== "running") {
    return { ok: true, message: "Job was al afgerond.", job: publicJobView(snap) };
  }
  await ref.set(
    {
      status: "cancelled",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return {
    ok: true,
    message: "Server-sync geannuleerd.",
    job: publicJobView({ id: jobId, data: () => ({ ...snap.data(), status: "cancelled" }) }),
  };
});

async function jobWasCancelled(uid, jobId) {
  const snap = await jobRef(uid, jobId).get();
  return snap.exists && snap.data().status === "cancelled";
}

async function processStravaSyncJob(uid, jobId) {
  const ref = jobRef(uid, jobId);
  const snap = await ref.get();
  if (!snap.exists) {
    functions.logger.warn("stravaSyncWorker missing job", uid, jobId);
    return;
  }
  let job = snap.data();
  if (job.status === "cancelled" || job.status === "completed" || job.status === "failed") {
    return;
  }
  if (job.status === "running" && isStaleRunningJob(job)) {
    functions.logger.warn("stravaSyncWorker taking over stale running job", uid, jobId);
  }

  await ref.set(
    {
      status: "running",
      workerStartedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  const { runStravaSyncBatch } = require("./strava");
  const reset = Boolean(job.firstBatchPending);
  const payload = {
    datasetId: job.datasetId,
    reset,
    ...(job.afterMs != null ? { after: job.afterMs } : {}),
    ...(job.beforeMs != null ? { before: job.beforeMs } : {}),
  };

  let result;
  try {
    result = await runStravaSyncBatch(uid, payload);
  } catch (e) {
    if (await jobWasCancelled(uid, jobId)) {
      functions.logger.info("stravaSyncWorker batch aborted (cancelled)", uid, jobId);
      return;
    }
    const {
      isStravaRateLimitError,
      rateLimitBatchDelaySeconds,
      formatRateLimitJobMessage,
    } = require("./strava");
    if (isStravaRateLimitError(e)) {
      const retryCount = (job.rateLimitRetryCount || 0) + 1;
      const batchCount = job.batchCount || 0;
      if (
        retryCount > MAX_RATE_LIMIT_RETRIES_WITHOUT_PROGRESS &&
        batchCount === 0
      ) {
        const rl = e.stravaRateLimit;
        const quota =
          rl && rl.usageDay != null && rl.limitDay != null
            ? `${rl.usageDay}/${rl.limitDay} reads vandaag`
            : "quota uitgeput";
        await markJobFailed(
          uid,
          jobId,
          `Strava blijft 429 (${quota}). Annuleer eventuele server-sync, wacht tot UTC-midnight of morgen, sync dan opnieuw (of eerst één regio).`
        );
        return;
      }
      const delaySec = rateLimitBatchDelaySeconds(e);
      functions.logger.warn("stravaSyncWorker Strava rate limit — reschedule batch", {
        uid,
        jobId,
        retryCount,
        delaySec,
        stravaRateLimit: e.stravaRateLimit || null,
      });
      await ref.set(
        {
          status: "queued",
          rateLimitRetryCount: retryCount,
          lastMessage: formatRateLimitJobMessage(e, delaySec),
          error: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      try {
        await enqueueWorkerTask({ uid, jobId }, delaySec);
      } catch (enqueueErr) {
        await markJobFailed(
          uid,
          jobId,
          `Strava rate limit en Cloud Task mislukt: ${enqueueErr.message || enqueueErr}`
        );
      }
      return;
    }
    if (e instanceof functions.https.HttpsError) {
      if (e.code === "failed-precondition" || e.code === "unauthenticated") {
        await markJobFailed(uid, jobId, e.message);
        return;
      }
    }
    const detail = e?.message || String(e);
    if (/deadline|timeout|DEADLINE_EXCEEDED|memory|ENOMEM/i.test(detail)) {
      await markJobFailed(
        uid,
        jobId,
        `Batch time-out of geheugenlimiet: ${detail.slice(0, 200)}. Probeer kleinere scope (één regio) of later opnieuw.`
      );
      return;
    }
    functions.logger.error("stravaSyncWorker batch", uid, jobId, e);
    await markJobFailed(uid, jobId, detail.slice(0, 500));
    return;
  }

  if (await jobWasCancelled(uid, jobId)) {
    functions.logger.info("stravaSyncWorker skip enqueue (cancelled)", uid, jobId);
    return;
  }

  const summary = result.summary || {};
  const batchCount = (job.batchCount || 0) + 1;
  const progress = progressFromSummary(summary);

  if (result.completed) {
    await ref.set(
      {
        status: "completed",
        firstBatchPending: false,
        batchCount,
        progress,
        lastMessage: result.message || "Sync klaar.",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return;
  }

  await ref.set(
    {
      status: "queued",
      firstBatchPending: false,
      batchCount,
      progress,
      lastMessage: result.message || "Batch klaar — volgende batch gepland.",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  try {
    await enqueueWorkerTask({ uid, jobId }, BATCH_DELAY_SECONDS);
  } catch (enqueueErr) {
    functions.logger.error("stravaSyncWorker enqueue next batch", uid, jobId, enqueueErr);
    await markJobFailed(
      uid,
      jobId,
      enqueueErr.message || cloudTasksErrorMessage(enqueueErr)
    );
  }
}

/** Gen1 HTTP worker (niet `stravaSyncWorker` — die naam kan nog als Gen2 task-queue in GCP staan). */
exports.stravaSyncWorkerHttp = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 300, memory: "1GB" })
  .https.onRequest(async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    const secret = stravaCfg().worker_secret;
    const header = req.get(WORKER_SECRET_HEADER) || req.get(WORKER_SECRET_HEADER.toUpperCase());
    if (!secret || header !== String(secret)) {
      res.status(403).send("Forbidden");
      return;
    }
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        res.status(400).send("Bad JSON");
        return;
      }
    }
    const uid = String(body?.uid || "");
    const jobId = String(body?.jobId || "");
    if (!uid || !jobId) {
      res.status(400).send("uid and jobId required");
      return;
    }
    try {
      await processStravaSyncJob(uid, jobId);
      res.status(200).json({ ok: true });
    } catch (e) {
      functions.logger.error("stravaSyncWorker", e);
      try {
        const ref = jobRef(uid, jobId);
        const snap = await ref.get();
        const st = snap.data()?.status;
        if (snap.exists && (st === "running" || st === "queued")) {
          await markJobFailed(uid, jobId, e.message || "Worker onverwachte fout");
        }
      } catch (markErr) {
        functions.logger.error("stravaSyncWorker markJobFailed", markErr);
      }
      res.status(500).send(e.message || "batch failed");
    }
  });
