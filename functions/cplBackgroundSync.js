/**
 * CPL full-database sync via Cloud Tasks (zelfde patroon als Strava server-sync).
 */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { CloudTasksClient } = require("@google-cloud/tasks");
const { cplCfg, authIdentityFromContext } = require("./cplClient");

const REGION = "europe-west1";
const TASK_QUEUE_ID = "cpl-sync";
const JOB_COLLECTION = "cplSyncJobs";
const ACTIVE_STATUSES = ["queued", "running"];
const BATCH_DELAY_SECONDS = 8;
const WORKER_SECRET_HEADER = "x-fietsklim-cpl-worker-secret";
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

function projectId() {
  return process.env.GCLOUD_PROJECT || admin.app().options.projectId || "climb-database";
}

function workerUrl() {
  const custom = cplCfg().worker_url;
  if (custom && String(custom).trim()) return String(custom).trim();
  return `https://${REGION}-${projectId()}.cloudfunctions.net/cplSyncWorkerHttp`;
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
  const view = {
    id,
    status: d.status,
    datasetId: d.datasetId,
    error: d.error || null,
    createdAt: d.createdAt?.toDate?.()?.toISOString?.() || null,
    updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() || null,
    progress: d.progress || null,
    after: d.afterMs ?? null,
    before: d.beforeMs ?? null,
    batchCount: d.batchCount ?? 0,
    lastMessage: d.lastMessage || null,
  };
  const policy = d.routeMapPolicy === "intervals_only" ? "intervals_only" : "default";
  view.routeMapPolicy = policy;
  view.routeSource = policy === "intervals_only" ? "cpl-intervals" : "cpl";
  return view;
}

async function reconcileStaleRunningJob(uid, docSnap) {
  const data = docSnap.data();
  if (!isStaleRunningJob(data)) return docSnap;
  const msg =
    "CPL server-sync hing vast op 'running' — waarschijnlijk time-out. Annuleer en start opnieuw.";
  await jobRef(uid, docSnap.id).set(
    {
      status: "failed",
      error: msg,
      lastMessage: "Automatisch afgebroken (stale lease).",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return jobRef(uid, docSnap.id).get();
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
  if (status !== "queued" && status !== "running") return null;
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
  return { uid: context.auth.uid, email: context.auth.token.email.trim() };
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
    throw new functions.https.HttpsError("invalid-argument", "Datum ‘tot’ moet na ‘van’ liggen.");
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
    regionProgress: summary.regionProgress ?? null,
    cplMatchWrites: summary.cplMatchWrites ?? 0,
    cplMatchCached: summary.cplMatchCached ?? 0,
    importOnly: Boolean(summary.importOnly),
    completed: Boolean(summary.completed),
  };
}

let tasksClient;
function getTasksClient() {
  if (!tasksClient) tasksClient = new CloudTasksClient();
  return tasksClient;
}

async function enqueueWorkerTask(payload, delaySeconds = 0) {
  const secret = cplCfg().worker_secret;
  if (!secret) {
    throw new Error("cpl.worker_secret ontbreekt — zet via functions:config:set cpl.worker_secret=…");
  }
  const client = getTasksClient();
  const parent = client.queuePath(projectId(), REGION, TASK_QUEUE_ID);
  const scheduleTime =
    delaySeconds > 0 ? { seconds: Math.floor(Date.now() / 1000) + delaySeconds } : undefined;
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
  await client.createTask({ parent, task });
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
exports.isBackgroundSyncConfigured = function isBackgroundSyncConfigured() {
  return Boolean(cplCfg().worker_secret);
};

async function assertNoOtherRouteSyncJob(uid) {
  const stravaBg = require("./stravaBackgroundSync");
  const stravaActive = await stravaBg.getActiveSyncJob(uid);
  if (stravaActive) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      `Er loopt al een Strava server-sync (${stravaActive.status}). Wacht of annuleer die eerst.`
    );
  }
}

/**
 * @param {string} uid
 * @param {string} email
 * @param {{ datasetId?: string, after?: number, before?: number }} data
 */
async function enqueueFullSyncJob(uid, emailOrIdentity, data, opts = {}) {
  const identity =
    typeof emailOrIdentity === "string"
      ? { email: emailOrIdentity, googleUid: null }
      : emailOrIdentity || {};
  const email = identity.email || "";
  if (!cplCfg().worker_secret) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "CPL server-sync is nog niet geconfigureerd (cpl.worker_secret)."
    );
  }
  const datasetId = String(data.datasetId || "__all__").trim();
  const existing = await getActiveSyncJob(uid);
  if (existing) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      `Er loopt al een CPL server-sync (${existing.status}).`
    );
  }
  if (!opts.fromWebhook) {
    await assertNoOtherRouteSyncJob(uid);
  } else {
    const stravaBg = require("./stravaBackgroundSync");
    const stravaActive = await stravaBg.getActiveSyncJob(uid);
    if (stravaActive) {
      return { ok: false, skipped: "strava_job_active", stravaStatus: stravaActive.status };
    }
  }
  const bounds = parseBounds(data);
  const routeMapPolicy =
    data.routeMapPolicy === "intervals_only" ? "intervals_only" : "default";
  const importOnly = Boolean(data.importOnly);
  const forceRematch = Boolean(data.forceRematch);
  const jobId = admin.firestore().collection("_").doc().id;
  const now = admin.firestore.FieldValue.serverTimestamp();
  await jobRef(uid, jobId).set({
    status: "queued",
    datasetId,
    routeMapPolicy,
    importOnly,
    forceRematch,
    triggerSource: opts.fromWebhook ? "strava_webhook" : data.triggerSource || null,
    afterMs: bounds.afterMs,
    beforeMs: bounds.beforeMs,
    batchCount: 0,
    firstBatchPending: true,
    createdAt: now,
    updatedAt: now,
    error: null,
    progress: { activitiesScanned: 0, uniqueClimbs: 0, completed: false },
  });
  try {
    await enqueueWorkerTask(
      { uid, jobId, email, googleUid: identity.googleUid || null },
      0
    );
  } catch (enqueueErr) {
    await jobRef(uid, jobId).delete().catch(() => {});
    throw new functions.https.HttpsError("failed-precondition", enqueueErr.message || String(enqueueErr));
  }
  const created = await jobRef(uid, jobId).get();
  const job = publicJobView(created);
  if (job) {
    job.routeMapPolicy = routeMapPolicy;
    job.routeSource = routeMapPolicy === "intervals_only" ? "cpl-intervals" : "cpl";
  }
  const policyLabel =
    routeMapPolicy === "intervals_only"
      ? "alleen Intervals-map uit CPL"
      : "Intervals-map, anders Strava-map uit CPL";
  return {
    ok: true,
    jobId,
    routeMapPolicy,
    routeSource: routeMapPolicy === "intervals_only" ? "cpl-intervals" : "cpl",
    message: `Server-sync via Performance Lab (${policyLabel}, geen Strava API).`,
    job,
  };
}

const WEBHOOK_ENQUEUE_DEBOUNCE_MS = 5 * 60 * 1000;

/**
 * Strava webhook → CPL Cloud Task (geen browser-tab nodig).
 * @returns {Promise<{ ok?: boolean, skipped?: string, jobId?: string }>}
 */
async function enqueueIncrementalCplFromWebhook(uid, event) {
  if (!cplCfg().worker_secret) {
    return { skipped: "cpl_worker_not_configured" };
  }
  const { resolveCplOwner } = require("./cplClient");
  let email = "";
  try {
    const user = await admin.auth().getUser(uid);
    email = user.email || "";
  } catch (e) {
    functions.logger.warn("enqueueIncrementalCplFromWebhook getUser", e?.message || e);
  }
  const owner = await resolveCplOwner({ email });
  if (!owner) {
    return { skipped: "no_cpl_account" };
  }

  const objectId = event?.object_id != null ? String(event.object_id) : "";
  const cplIntegRef = admin.firestore().collection("users").doc(uid).collection("integrations").doc("cpl");
  const cplSnap = await cplIntegRef.get();
  const lastAuto = cplSnap.exists ? cplSnap.data()?.lastWebhookAutoEnqueue : null;
  if (
    objectId &&
    lastAuto?.objectId === objectId &&
    Date.now() - (lastAuto.atMs || 0) < WEBHOOK_ENQUEUE_DEBOUNCE_MS
  ) {
    return { skipped: "debounced", objectId };
  }

  const eventSec = Number(event?.event_time);
  const afterMs =
    Number.isFinite(eventSec) && eventSec > 0
      ? (eventSec - 86400) * 1000
      : Date.now() - 7 * 86400000;

  let result;
  try {
    result = await enqueueFullSyncJob(
      uid,
      { email: owner.email || email, googleUid: null },
      { datasetId: "__all__", after: afterMs },
      { fromWebhook: true }
    );
  } catch (e) {
    if (e?.code === "failed-precondition") {
      return { skipped: e.message || "enqueue_failed" };
    }
    throw e;
  }
  if (result?.skipped || result?.ok === false) {
    return { skipped: result.skipped || "not_enqueued" };
  }

  await cplIntegRef.set(
    {
      lastWebhookAutoEnqueue: { objectId, atMs: Date.now(), jobId: result.jobId },
    },
    { merge: true }
  );

  const stravaIntegRef = admin
    .firestore()
    .collection("users")
    .doc(uid)
    .collection("integrations")
    .doc("strava");
  await stravaIntegRef.set(
    {
      webhookPending: admin.firestore.FieldValue.delete(),
      webhookPendingAt: admin.firestore.FieldValue.delete(),
      webhookCplJobId: result.jobId,
      webhookHandledAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { ok: true, jobId: result.jobId };
}

exports.enqueueFullSyncJob = enqueueFullSyncJob;
exports.enqueueIncrementalCplFromWebhook = enqueueIncrementalCplFromWebhook;

exports.cplEnqueueFullSync = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 120, memory: "256MB" })
  .https.onCall(async (data, context) => {
    const { uid } = requireAuth(context);
    return enqueueFullSyncJob(uid, authIdentityFromContext(context), data);
  });

exports.cplImportLogbookFromCpl = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 120, memory: "256MB" })
  .https.onCall(async (data, context) => {
    const { uid } = requireAuth(context);
    return enqueueFullSyncJob(uid, authIdentityFromContext(context), {
      ...data,
      importOnly: true,
    });
  });

exports.getCplSyncJob = functions.region(REGION).https.onCall(async (data, context) => {
  const { uid } = requireAuth(context);
  const jobId = String(data.jobId || "").trim();
  if (jobId) {
    let snap = await jobRef(uid, jobId).get();
    if (!snap.exists) {
      throw new functions.https.HttpsError("not-found", "Sync-job niet gevonden.");
    }
    if (snap.data().status === "running") {
      snap = await reconcileStaleRunningJob(uid, snap);
    }
    return { job: publicJobView(snap) };
  }
  return { job: await getActiveSyncJob(uid) };
});

exports.cplCancelSyncJob = functions.region(REGION).https.onCall(async (data, context) => {
  const { uid } = requireAuth(context);
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
    { status: "cancelled", updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
  return { ok: true, message: "CPL server-sync geannuleerd.", job: publicJobView(snap) };
});

async function jobWasCancelled(uid, jobId) {
  const snap = await jobRef(uid, jobId).get();
  return snap.exists && snap.data().status === "cancelled";
}

async function processCplSyncJob(uid, jobId, identity) {
  const email = typeof identity === "string" ? identity : identity?.email || "";
  const googleUid = typeof identity === "object" ? identity?.googleUid : null;
  const ref = jobRef(uid, jobId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const job = snap.data();
  if (job.status === "cancelled" || job.status === "completed" || job.status === "failed") return;

  await ref.set(
    { status: "running", updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );

  const { runCplSyncBatch } = require("./cplSync");
  const payload = {
    datasetId: job.datasetId,
    reset: Boolean(job.firstBatchPending),
    routeMapPolicy: job.routeMapPolicy === "intervals_only" ? "intervals_only" : "default",
    importOnly: Boolean(job.importOnly),
    forceRematch: Boolean(job.forceRematch),
    ...(job.afterMs != null ? { after: job.afterMs } : {}),
    ...(job.beforeMs != null ? { before: job.beforeMs } : {}),
  };

  let result;
  try {
    result = await runCplSyncBatch(uid, { email, googleUid }, payload);
  } catch (e) {
    if (await jobWasCancelled(uid, jobId)) return;
    if (e instanceof functions.https.HttpsError) {
      await markJobFailed(uid, jobId, e.message);
      return;
    }
    await markJobFailed(uid, jobId, (e?.message || String(e)).slice(0, 500));
    return;
  }

  if (await jobWasCancelled(uid, jobId)) return;

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
      lastMessage: result.message || "Batch klaar — volgende gepland.",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  try {
    await enqueueWorkerTask(
      { uid, jobId, email, googleUid: googleUid || null },
      BATCH_DELAY_SECONDS
    );
  } catch (enqueueErr) {
    await markJobFailed(uid, jobId, enqueueErr.message || String(enqueueErr));
  }
}

exports.cplSyncWorkerHttp = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 300, memory: "1GB" })
  .https.onRequest(async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    const secret = cplCfg().worker_secret;
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
    const email = String(body?.email || "");
    const googleUid = body?.googleUid ? String(body.googleUid) : null;
    if (!uid || !jobId || !email) {
      res.status(400).send("uid, jobId and email required");
      return;
    }
    try {
      await processCplSyncJob(uid, jobId, { email, googleUid });
      res.status(200).json({ ok: true });
    } catch (e) {
      functions.logger.error("cplSyncWorker", e);
      res.status(500).send(e.message || "batch failed");
    }
  });
