const functions = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");
const { matchClimbToActivity, isCyclingActivity, climbsNearEncodedPolyline } = require("./climbMatch");

const REGION = "europe-west1";
const STRAVA_AUTH = "https://www.strava.com/oauth/authorize";
const STRAVA_TOKEN = "https://www.strava.com/oauth/token";
const STRAVA_API = "https://www.strava.com/api/v3";
const SCOPES_PUBLIC = "read,activity:read";
const SCOPES_WITH_PRIVATE = "read,activity:read,activity:read_all";
const STATE_TTL_MS = 15 * 60 * 1000;
const TRIAL_ACTIVITY_COUNT = 50;
const FULL_SYNC_PER_PAGE = 50;
const FULL_SYNC_MAX_PAGES_PER_CALL = 12;
/** Minder Strava-pagina’s per call wanneer elke batch meerdere regio-datasets doorloopt. */
const FULL_SYNC_MAX_PAGES_ALL_MODE = 3;
const FULL_SYNC_DATASETS_PER_CALL = 5;
/** datasetId in API / UI voor sync tegen index.json (alle regio’s). */
const ALL_DATASETS_TOKEN = "__all__";

/** Strava Authorization Callback Domain = vccharlie.github.io (gedeeld met andere repo’s). */
const DEFAULT_REDIRECT_URI =
  "https://vccharlie.github.io/Climbfinder-scraper/climbs/strava-callback.html";

function stravaCfg() {
  return functions.config().strava || {};
}

function siteReturnUrl() {
  return (
    stravaCfg().site_return_url ||
    "https://vccharlie.github.io/Climbfinder-scraper/climbs/settings.html"
  );
}

function dataBaseUrl() {
  return (
    stravaCfg().data_base_url ||
    "https://raw.githubusercontent.com/VCCharlie/Climbfinder-scraper/main/docs/climbs/data"
  );
}

function redirectUri() {
  const u = stravaCfg().redirect_uri;
  return (u && String(u).trim()) || DEFAULT_REDIRECT_URI;
}

function stravaBackendConfigured() {
  const c = stravaCfg();
  return Boolean(c.client_id && c.client_secret);
}

function allowedEmail(email) {
  const cfg = functions.config().auth || {};
  const list = (cfg.allowed_emails || "vr.deruiter@gmail.com")
    .split(",")
    .map((s) => s.trim().toLowerCase());
  return email && list.includes(email.trim().toLowerCase());
}

function requireAuth(context) {
  if (!context.auth?.token?.email) {
    throw new functions.https.HttpsError("unauthenticated", "Log in met Google.");
  }
  if (!allowedEmail(context.auth.token.email)) {
    throw new functions.https.HttpsError("permission-denied", "Geen toegang.");
  }
  return context.auth.uid;
}

function logDocId(datasetId, climbId) {
  return `${datasetId}__${climbId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 450);
}

async function integrationRef(uid) {
  return admin.firestore().collection("users").doc(uid).collection("integrations").doc("strava");
}

function stravaPrefsRef(uid) {
  return admin.firestore().collection("users").doc(uid).collection("prefs").doc("strava");
}

async function getStravaPrefs(uid) {
  try {
    const snap = await stravaPrefsRef(uid).get();
    if (snap.exists) {
      return { includePrivate: Boolean(snap.data().includePrivate) };
    }
  } catch (e) {
    functions.logger.warn("getStravaPrefs prefs doc", e);
  }
  try {
    const integration = await getStoredIntegration(uid);
    if (integration && integration.syncIncludePrivate !== undefined) {
      return { includePrivate: Boolean(integration.syncIncludePrivate) };
    }
  } catch (e) {
    functions.logger.warn("getStravaPrefs integration", e);
  }
  return { includePrivate: false };
}

async function saveStravaIncludePrivate(uid, includePrivate) {
  await stravaPrefsRef(uid).set(
    {
      includePrivate: Boolean(includePrivate),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  const integRef = await integrationRef(uid);
  const integSnap = await integRef.get();
  if (integSnap.exists) {
    await integRef.set({ syncIncludePrivate: Boolean(includePrivate) }, { merge: true });
  }
}

function scopesForIncludePrivate(includePrivate) {
  return includePrivate ? SCOPES_WITH_PRIVATE : SCOPES_PUBLIC;
}

function integrationHasPrivateScope(scopeStr) {
  if (!scopeStr) return false;
  return String(scopeStr).split(",").map((s) => s.trim()).includes("activity:read_all");
}

function activityVisibleForPrefs(activity, includePrivate) {
  if (!activity) return false;
  if (!includePrivate && activity.private === true) return false;
  return true;
}

async function getStoredIntegration(uid) {
  const snap = await (await integrationRef(uid)).get();
  return snap.exists ? snap.data() : null;
}

async function stravaFetch(path, accessToken) {
  const res = await fetch(`${STRAVA_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Strava API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function refreshAccessToken(integration) {
  const clientId = stravaCfg().client_id;
  const clientSecret = stravaCfg().client_secret;
  if (!clientId || !clientSecret) {
    throw new Error("strava.client_id / client_secret ontbreken");
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: integration.refreshToken,
  });
  const res = await fetch(STRAVA_TOKEN, { method: "POST", body });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Strava token refresh ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function getValidAccessToken(uid) {
  const ref = await integrationRef(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new functions.https.HttpsError("failed-precondition", "Strava is niet gekoppeld.");
  }
  let data = snap.data();
  const expiresAt = data.expiresAt || 0;
  if (Date.now() > expiresAt - 120_000) {
    const tok = await refreshAccessToken(data);
    data = {
      ...data,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || data.refreshToken,
      expiresAt: Date.now() + (tok.expires_in || 21600) * 1000,
    };
    await ref.set(data, { merge: true });
  }
  return data.accessToken;
}

async function loadDataset(datasetId) {
  const url = `${dataBaseUrl().replace(/\/$/, "")}/${datasetId}.json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Dataset ${datasetId} laden mislukt (${res.status})`);
  }
  const bundle = await res.json();
  return { datasetId, climbs: bundle.climbs || [], meta: bundle.meta || {} };
}

function isAllDatasetsToken(datasetId) {
  return datasetId === ALL_DATASETS_TOKEN;
}

async function loadRegionDatasetIds() {
  const url = `${dataBaseUrl().replace(/\/$/, "")}/index.json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`index.json laden mislukt (${res.status})`);
  }
  const index = await res.json();
  const ids = (index.regions || []).map((r) => String(r.id || "").trim()).filter(Boolean);
  return { ids, totalClimbs: index.total_climbs ?? null, regionCount: ids.length };
}

async function assertPrivateScopeIfNeeded(uid, prefs) {
  if (!prefs.includePrivate) return;
  const integration = await getStoredIntegration(uid);
  if (!integrationHasPrivateScope(integration?.scope)) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Privé-activiteiten aan, maar Strava heeft activity:read_all nog niet — koppel Strava opnieuw."
    );
  }
}

function countRideActivities(activities, includePrivate) {
  return (activities || [])
    .filter(isCyclingActivity)
    .filter((act) => activityVisibleForPrefs(act, includePrivate)).length;
}

async function matchAndWriteForDatasets(uid, accessToken, activities, includePrivate, datasetIds) {
  let matchesWritten = 0;
  const datasetsProcessed = [];
  for (const datasetId of datasetIds) {
    const { climbs } = await loadDataset(datasetId);
    if (!climbs.length) continue;
    const { bestByClimb } = await matchActivitiesToClimbs({
      accessToken,
      climbs,
      activities,
      includePrivate,
    });
    if (bestByClimb.size) {
      await writeStravaMatches(uid, datasetId, bestByClimb);
      matchesWritten += bestByClimb.size;
    }
    datasetsProcessed.push(datasetId);
  }
  return { matchesWritten, datasetsProcessed };
}

async function consumeOAuthState(state) {
  const stateRef = admin.firestore().collection("stravaOAuthStates").doc(state);
  const stateSnap = await stateRef.get();
  if (!stateSnap.exists) {
    throw new functions.https.HttpsError("failed-precondition", "Ongeldige of verlopen state.");
  }
  const data = stateSnap.data();
  await stateRef.delete();
  const createdAt = data.createdAt;
  if (createdAt?.toMillis && Date.now() - createdAt.toMillis() > STATE_TTL_MS) {
    throw new functions.https.HttpsError("failed-precondition", "State verlopen — koppel Strava opnieuw.");
  }
  return data;
}

async function exchangeCodeAndStoreIntegration(uid, code, options) {
  const includePrivate = Boolean(options?.includePrivate);
  const clientId = stravaCfg().client_id;
  const clientSecret = stravaCfg().client_secret;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
  });
  const tokRes = await fetch(STRAVA_TOKEN, { method: "POST", body });
  if (!tokRes.ok) {
    const text = await tokRes.text();
    functions.logger.error("Strava token exchange", text);
    throw new functions.https.HttpsError("internal", "Strava-token mislukt (redirect_uri moet exact matchen).");
  }
  const tok = await tokRes.json();
  const athlete = tok.athlete || {};
  const grantedScope = tok.scope || scopesForIncludePrivate(includePrivate);

  await saveStravaIncludePrivate(uid, includePrivate);

  await (await integrationRef(uid)).set({
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: Date.now() + (tok.expires_in || 21600) * 1000,
    athleteId: athlete.id || null,
    athleteName: [athlete.firstname, athlete.lastname].filter(Boolean).join(" ") || null,
    scope: grantedScope,
    syncIncludePrivate: includePrivate,
    connectedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastSyncAt: null,
    lastSyncSummary: null,
    fullSyncCursor: null,
  });
}

exports.setStravaSyncPrefs = functions.region(REGION).https.onCall(async (data, context) => {
  try {
    const uid = requireAuth(context);
    const includePrivate = Boolean(data?.includePrivate);
    await saveStravaIncludePrivate(uid, includePrivate);
    const integration = await getStoredIntegration(uid);
    const needsReconnect =
      includePrivate && integration && !integrationHasPrivateScope(integration.scope);
    return {
      ok: true,
      includePrivate,
      needsReconnect,
      message: needsReconnect
        ? "Privé vereist extra Strava-toestemming — klik opnieuw Koppel Strava."
        : "Voorkeur opgeslagen.",
    };
  } catch (e) {
    functions.logger.error("setStravaSyncPrefs", e);
    if (e instanceof functions.https.HttpsError) throw e;
    throw new functions.https.HttpsError(
      "internal",
      `Strava-voorkeur opslaan mislukt: ${e.message || String(e)}. Draai de workflow Deploy Climbfinder import function (bevat setStravaSyncPrefs).`
    );
  }
});

exports.getStravaConnectUrl = functions.region(REGION).https.onCall(async (data, context) => {
  try {
    const uid = requireAuth(context);
    const clientId = stravaCfg().client_id;
    if (!clientId) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "strava.client_id ontbreekt op Firebase Functions. Zie docs/auth/STRAVA.md."
      );
    }
    const prefs = await getStravaPrefs(uid);
    const includePrivate =
      data?.includePrivate !== undefined ? Boolean(data.includePrivate) : prefs.includePrivate;
    await saveStravaIncludePrivate(uid, includePrivate);

    const integration = await getStoredIntegration(uid);
    const scopeUpgraded = includePrivate && !integrationHasPrivateScope(integration?.scope);
    const scopes = scopesForIncludePrivate(includePrivate);

    const redir = redirectUri();
    const returnUrl = String(data?.returnUrl || siteReturnUrl()).trim() || siteReturnUrl();

    const state = crypto.randomBytes(24).toString("hex");
    await admin.firestore().collection("stravaOAuthStates").doc(state).set({
      uid,
      returnUrl,
      includePrivate,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redir,
      response_type: "code",
      approval_prompt: scopeUpgraded || includePrivate ? "force" : "auto",
      scope: scopes,
      state,
    });

    return { url: `${STRAVA_AUTH}?${params.toString()}`, scopes, includePrivate };
  } catch (e) {
    if (e instanceof functions.https.HttpsError) throw e;
    functions.logger.error("getStravaConnectUrl", e);
    throw new functions.https.HttpsError(
      "internal",
      `Strava-koppeling mislukt: ${e.message || String(e)}`
    );
  }
});

/** Na redirect op GitHub Pages (strava-callback.html) — ingelogde gebruiker wisselt code voor tokens. */
exports.stravaCompleteOAuth = functions.region(REGION).https.onCall(async (data, context) => {
  const uid = requireAuth(context);
  const code = String(data?.code || "").trim();
  const state = String(data?.state || "").trim();
  if (!code || !state) {
    throw new functions.https.HttpsError("invalid-argument", "code en state zijn verplicht.");
  }
  const stateData = await consumeOAuthState(state);
  if (stateData.uid !== uid) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "State hoort bij een andere login — start Koppel Strava opnieuw."
    );
  }
  await exchangeCodeAndStoreIntegration(uid, code, {
    includePrivate: Boolean(stateData.includePrivate),
  });
  const returnUrl = String(stateData.returnUrl || siteReturnUrl()).trim() || siteReturnUrl();
  return { ok: true, returnUrl };
});

/** Legacy: cloudfunctions.net callback (niet gebruiken als Strava-domain = vccharlie.github.io). */
exports.stravaOAuthCallback = functions.region(REGION).https.onRequest(async (req, res) => {
  try {
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    const err = req.query.error;

    if (err) {
      res.redirect(302, `${siteReturnUrl()}?strava=denied`);
      return;
    }
    if (!code || !state) {
      res.status(400).send("code/state ontbreekt");
      return;
    }

    const stateData = await consumeOAuthState(state);
    const { uid } = stateData;
    await exchangeCodeAndStoreIntegration(uid, code, {
      includePrivate: Boolean(stateData.includePrivate),
    });
    const returnUrl = String(stateData.returnUrl || siteReturnUrl()).trim() || siteReturnUrl();
    res.redirect(302, `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}strava=connected`);
  } catch (e) {
    functions.logger.error("stravaOAuthCallback", e);
    res.redirect(302, `${siteReturnUrl()}?strava=error`);
  }
});

exports.stravaDisconnect = functions.region(REGION).https.onCall(async (_data, context) => {
  const uid = requireAuth(context);
  await (await integrationRef(uid)).delete();
  return { ok: true, message: "Strava losgekoppeld." };
});

exports.getStravaStatus = functions.region(REGION).https.onCall(async (_data, context) => {
  const uid = requireAuth(context);
  const setup = { backendConfigured: stravaBackendConfigured() };
  let prefs = { includePrivate: false };
  try {
    prefs = await getStravaPrefs(uid);
  } catch (e) {
    functions.logger.warn("getStravaStatus prefs", e);
  }
  try {
    const data = await getStoredIntegration(uid);
    if (!data) {
      return { connected: false, setup, includePrivate: prefs.includePrivate };
    }
    const hasPrivateScope = integrationHasPrivateScope(data.scope);
    const needsReconnect = prefs.includePrivate && !hasPrivateScope;
    return {
      connected: true,
      athleteName: data.athleteName || null,
      lastSyncAt: data.lastSyncAt?.toDate?.()?.toISOString?.() || null,
      lastSyncSummary: data.lastSyncSummary || null,
      includePrivate: prefs.includePrivate,
      hasPrivateScope,
      needsReconnect,
      grantedScope: data.scope || null,
      fullSyncCursor: data.fullSyncCursor || null,
      setup,
    };
  } catch (e) {
    functions.logger.error("getStravaStatus", e);
    return {
      connected: false,
      setup,
      firestoreError: true,
      hint: e.message || String(e),
    };
  }
});

async function matchActivitiesToClimbs({ accessToken, climbs, activities, includePrivate }) {
  const rides = (activities || [])
    .filter(isCyclingActivity)
    .filter((act) => activityVisibleForPrefs(act, includePrivate));

  /** @type {Map<string, { activity: object, coverage: number }>} */
  const bestByClimb = new Map();

  for (const act of rides) {
    let poly = act.map?.summary_polyline;
    if (!poly) {
      try {
        const detail = await stravaFetch(`/activities/${act.id}`, accessToken);
        poly = detail.map?.summary_polyline;
      } catch (e) {
        functions.logger.warn("activity detail skip", act.id, e.message);
        continue;
      }
    }
    if (!poly) continue;

    const candidates = climbsNearEncodedPolyline(climbs, poly);
    for (const climb of candidates) {
      const result = matchClimbToActivity(climb, poly);
      if (!result.matched) continue;
      const prev = bestByClimb.get(climb.id);
      if (!prev || result.coverage > prev.coverage) {
        bestByClimb.set(climb.id, { activity: act, coverage: result.coverage });
      }
    }
  }

  return { bestByClimb, ridesScanned: rides.length };
}

async function writeStravaMatches(uid, datasetId, bestByClimb) {
  const db = admin.firestore();
  const logCol = db.collection("users").doc(uid).collection("climbLog");
  const entries = [...bestByClimb.entries()];
  for (let i = 0; i < entries.length; i += 400) {
    const batch = db.batch();
    for (const [climbId, hit] of entries.slice(i, i + 400)) {
      const ref = logCol.doc(logDocId(datasetId, climbId));
      batch.set(
        ref,
        {
          datasetId,
          climbId,
          done: true,
          wishlist: false,
          source: "strava",
          stravaActivityId: hit.activity.id,
          stravaActivityName: hit.activity.name || null,
          matchCoverage: hit.coverage,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    await batch.commit();
  }
}

async function fetchActivityPages(accessToken, { startPage, maxPages, perPage }) {
  const all = [];
  let page = Math.max(1, startPage);
  let pagesFetched = 0;
  let lastPageEmpty = false;
  while (pagesFetched < maxPages) {
    const chunk = await stravaFetch(
      `/athlete/activities?per_page=${perPage}&page=${page}`,
      accessToken
    );
    if (!chunk || !chunk.length) {
      lastPageEmpty = true;
      break;
    }
    all.push(...chunk);
    pagesFetched += 1;
    if (chunk.length < perPage) {
      lastPageEmpty = true;
      break;
    }
    page += 1;
  }
  const completed = lastPageEmpty;
  const nextPage = completed ? null : page;
  return { activities: all, pagesFetched, nextPage, completed };
}

exports.stravaSyncTrial = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 300, memory: "1GB" })
  .https.onCall(async (data, context) => {
    const uid = requireAuth(context);
    const datasetId = String(data.datasetId || "").trim();
    if (!datasetId) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "datasetId is verplicht (kies een regio-dataset of hele database)."
      );
    }
    const perPage = Math.min(Number(data.perPage) || TRIAL_ACTIVITY_COUNT, 50);
    const prefs = await getStravaPrefs(uid);
    await assertPrivateScopeIfNeeded(uid, prefs);

    const accessToken = await getValidAccessToken(uid);
    const activities = await stravaFetch(
      `/athlete/activities?per_page=${perPage}&page=1`,
      accessToken
    );
    const ridesScanned = countRideActivities(activities, prefs.includePrivate);

    let matchesWritten = 0;
    let summary;

    if (isAllDatasetsToken(datasetId)) {
      const { ids, totalClimbs, regionCount } = await loadRegionDatasetIds();
      if (!ids.length) {
        throw new functions.https.HttpsError("not-found", "Geen regio’s in index.json");
      }
      const result = await matchAndWriteForDatasets(
        uid,
        accessToken,
        activities,
        prefs.includePrivate,
        ids
      );
      matchesWritten = result.matchesWritten;
      summary = {
        kind: "trial",
        datasetId: ALL_DATASETS_TOKEN,
        allDatasets: true,
        regionCount,
        totalClimbs,
        activitiesScanned: ridesScanned,
        matchesWritten,
        uniqueClimbs: matchesWritten,
        perPage,
        includePrivate: prefs.includePrivate,
      };
    } else {
      const { climbs } = await loadDataset(datasetId);
      if (!climbs.length) {
        throw new functions.https.HttpsError("not-found", `Geen klimmen in ${datasetId}`);
      }
      const { bestByClimb } = await matchActivitiesToClimbs({
        accessToken,
        climbs,
        activities,
        includePrivate: prefs.includePrivate,
      });
      await writeStravaMatches(uid, datasetId, bestByClimb);
      matchesWritten = bestByClimb.size;
      summary = {
        kind: "trial",
        datasetId,
        activitiesScanned: ridesScanned,
        matchesWritten,
        uniqueClimbs: matchesWritten,
        perPage,
        includePrivate: prefs.includePrivate,
      };
    }

    await (await integrationRef(uid)).set(
      {
        lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSyncSummary: summary,
      },
      { merge: true }
    );

    const scopeLabel = isAllDatasetsToken(datasetId) ? "hele database" : datasetId;
    return {
      ok: true,
      message: `Proef-sync: ${matchesWritten} klim(men) gematcht (${scopeLabel}, ${ridesScanned} ritten).`,
      summary,
    };
  });

exports.stravaSyncFull = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 300, memory: "1GB" })
  .https.onCall(async (data, context) => {
    const uid = requireAuth(context);
    const datasetId = String(data.datasetId || "").trim();
    if (!datasetId) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "datasetId is verplicht (regio-dataset of hele database)."
      );
    }
    const prefs = await getStravaPrefs(uid);
    await assertPrivateScopeIfNeeded(uid, prefs);

    const reset = Boolean(data.reset);
    const integration = await getStoredIntegration(uid);
    const allMode = isAllDatasetsToken(datasetId);
    const accessToken = await getValidAccessToken(uid);

    if (!allMode) {
      let startPage = 1;
      if (
        !reset &&
        integration?.fullSyncCursor?.mode !== "all" &&
        integration?.fullSyncCursor?.datasetId === datasetId &&
        integration.fullSyncCursor.nextPage
      ) {
        startPage = Number(integration.fullSyncCursor.nextPage) || 1;
      }

      const maxPages = Math.min(
        Math.max(1, Number(data.maxPages) || FULL_SYNC_MAX_PAGES_PER_CALL),
        FULL_SYNC_MAX_PAGES_PER_CALL
      );

      const { climbs } = await loadDataset(datasetId);
      if (!climbs.length) {
        throw new functions.https.HttpsError("not-found", `Geen klimmen in ${datasetId}`);
      }

      const { activities, pagesFetched, nextPage, completed } = await fetchActivityPages(accessToken, {
        startPage,
        maxPages,
        perPage: FULL_SYNC_PER_PAGE,
      });

      const { bestByClimb, ridesScanned } = await matchActivitiesToClimbs({
        accessToken,
        climbs,
        activities,
        includePrivate: prefs.includePrivate,
      });
      await writeStravaMatches(uid, datasetId, bestByClimb);

      const cursor = completed
        ? null
        : { mode: "single", datasetId, nextPage, updatedAt: new Date().toISOString() };

      const summary = {
        kind: "full",
        datasetId,
        activitiesScanned: ridesScanned,
        activitiesFetched: activities.length,
        pagesFetched,
        startPage,
        nextPage,
        completed,
        matchesWritten: bestByClimb.size,
        uniqueClimbs: bestByClimb.size,
        includePrivate: prefs.includePrivate,
      };

      await (await integrationRef(uid)).set(
        {
          lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
          lastSyncSummary: summary,
          fullSyncCursor: cursor,
        },
        { merge: true }
      );

      const msg = completed
        ? `Volledige sync klaar: ${summary.uniqueClimbs} klim(men) in ${datasetId} (deze batch: ${ridesScanned} ritten, ${pagesFetched} pagina’s).`
        : `Sync batch klaar (${ridesScanned} ritten, pag. ${startPage}–${startPage + pagesFetched - 1}). Verder vanaf pag. ${nextPage}.`;

      return { ok: true, completed, nextPage, message: msg, summary };
    }

    const { ids: regionIds, totalClimbs, regionCount } = await loadRegionDatasetIds();
    if (!regionIds.length) {
      throw new functions.https.HttpsError("not-found", "Geen regio’s in index.json");
    }

    let startPage = 1;
    let nextDatasetIndex = 0;
    const prev = integration?.fullSyncCursor;
    if (!reset && prev?.mode === "all") {
      startPage = Number(prev.nextPage) || 1;
      nextDatasetIndex = Number(prev.nextDatasetIndex) || 0;
    }

    const maxPages = Math.min(
      Math.max(1, Number(data.maxPages) || FULL_SYNC_MAX_PAGES_ALL_MODE),
      FULL_SYNC_MAX_PAGES_ALL_MODE
    );
    const datasetsPerCall = Math.min(
      Math.max(1, Number(data.datasetsPerCall) || FULL_SYNC_DATASETS_PER_CALL),
      FULL_SYNC_DATASETS_PER_CALL
    );

    const { activities, pagesFetched, nextPage, completed: activitiesExhausted } =
      await fetchActivityPages(accessToken, {
        startPage,
        maxPages,
        perPage: FULL_SYNC_PER_PAGE,
      });

    const ridesScanned = countRideActivities(activities, prefs.includePrivate);
    const batchIds = regionIds.slice(nextDatasetIndex, nextDatasetIndex + datasetsPerCall);
    const { matchesWritten, datasetsProcessed } = await matchAndWriteForDatasets(
      uid,
      accessToken,
      activities,
      prefs.includePrivate,
      batchIds
    );

    let nextDatasetIndexAfter = nextDatasetIndex + batchIds.length;
    let syncCompleted = false;
    let cursor = null;
    let nextPageForCursor = startPage;

    if (nextDatasetIndexAfter >= regionIds.length) {
      nextDatasetIndexAfter = 0;
      if (activitiesExhausted) {
        syncCompleted = true;
      } else {
        nextPageForCursor = nextPage || startPage + pagesFetched;
      }
    } else {
      nextPageForCursor = startPage;
    }

    if (!syncCompleted) {
      cursor = {
        mode: "all",
        nextPage: nextPageForCursor,
        nextDatasetIndex: nextDatasetIndexAfter,
        updatedAt: new Date().toISOString(),
      };
    }

    const summary = {
      kind: "full",
      datasetId: ALL_DATASETS_TOKEN,
      allDatasets: true,
      regionCount,
      totalClimbs,
      activitiesScanned: ridesScanned,
      activitiesFetched: activities.length,
      pagesFetched,
      startPage,
      nextPage: activitiesExhausted ? null : nextPage,
      nextDatasetIndex: nextDatasetIndexAfter,
      datasetsInBatch: batchIds.length,
      datasetsProcessedCount: datasetsProcessed.length,
      regionProgress: syncCompleted
        ? `${regionCount}/${regionCount} regio’s`
        : nextDatasetIndexAfter === 0
          ? `regio’s klaar voor Strava-pag. ${startPage}–${startPage + pagesFetched - 1}; volgende ritten-batch`
          : `${nextDatasetIndexAfter}/${regionCount} regio’s (huidige ritten-batch)`,
      completed: syncCompleted,
      matchesWritten,
      uniqueClimbs: matchesWritten,
      includePrivate: prefs.includePrivate,
    };

    await (await integrationRef(uid)).set(
      {
        lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSyncSummary: summary,
        fullSyncCursor: cursor,
      },
      { merge: true }
    );

    const msg = syncCompleted
      ? `Volledige sync klaar: ${matchesWritten} nieuwe match(es) in deze batch · hele database (${regionCount} regio’s, ~${totalClimbs ?? "?"} klimmen).`
      : `Database-sync batch: ${matchesWritten} match(es), ritten pag. ${startPage}–${startPage + pagesFetched - 1}, regio’s ${nextDatasetIndex}–${nextDatasetIndex + batchIds.length - 1} van ${regionCount}. Automatisch verder…`;

    return {
      ok: true,
      completed: syncCompleted,
      nextPage: cursor?.nextPage ?? null,
      message: msg,
      summary,
    };
  });

exports.ALL_DATASETS_TOKEN = ALL_DATASETS_TOKEN;
