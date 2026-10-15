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

/** Klim-JSON staat op GitHub Pages; raw.githubusercontent.com geeft voor deze repo vaak 404. */
const DEFAULT_DATA_BASE_URL =
  "https://vccharlie.github.io/Climbfinder-scraper/climbs/data";
const FALLBACK_DATA_BASE_URLS = [
  DEFAULT_DATA_BASE_URL,
  "https://raw.githubusercontent.com/VCCharlie/Climbfinder-scraper/main/docs/climbs/data",
];

function configuredDataBaseUrls() {
  const custom = stravaCfg().data_base_url;
  if (custom && String(custom).trim()) {
    return [String(custom).trim(), ...FALLBACK_DATA_BASE_URLS];
  }
  return [...FALLBACK_DATA_BASE_URLS];
}

async function fetchDataJson(relativePath) {
  const path = relativePath.replace(/^\//, "");
  const tried = [];
  for (const base of configuredDataBaseUrls()) {
    const root = base.replace(/\/$/, "");
    const url = `${root}/${path}`;
    tried.push(url);
    const res = await fetch(url);
    if (res.ok) {
      return res.json();
    }
  }
  throw new Error(`${path} laden mislukt (404) — geprobeerd: ${tried.join(" | ")}`);
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

/** Strava gebruikt komma’s en/of spaties in scope-strings. */
function parseStravaScopes(scopeStr) {
  if (!scopeStr) return [];
  return String(scopeStr)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function integrationHasPrivateScope(scopeStr) {
  return parseStravaScopes(scopeStr).includes("activity:read_all");
}

function formatScopeString(scopeFromToken) {
  const scopes = parseStravaScopes(scopeFromToken);
  return scopes.length ? scopes.join(",") : "";
}

async function athleteCanReadPrivateActivities(accessToken) {
  try {
    const acts = await stravaFetch("/athlete/activities?per_page=15", accessToken);
    return Array.isArray(acts) && acts.some((a) => a.private === true);
  } catch (e) {
    functions.logger.warn("athleteCanReadPrivateActivities", e.message);
    return false;
  }
}

async function resolvePrivateScopeForStatus(uid, integration, prefs) {
  let scope = integration?.scope || "";
  let hasPrivate = integrationHasPrivateScope(scope);

  if (!prefs.includePrivate) {
    return { hasPrivateScope: hasPrivate, scope, needsReconnect: false };
  }

  if (hasPrivate) {
    return { hasPrivateScope: true, scope, needsReconnect: false };
  }

  // Na OAuth met privé: scope kan spaties i.p.v. komma’s gebruiken (Strava token response).
  if (integration?.lastOAuthIncludePrivate) {
    const reparsed = formatScopeString(scope);
    if (reparsed && reparsed !== scope) {
      scope = reparsed;
      await (await integrationRef(uid)).set(
        { scope: reparsed, scopeNormalizedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    }
    hasPrivate = integrationHasPrivateScope(scope);
    if (hasPrivate) {
      return { hasPrivateScope: true, scope, needsReconnect: false };
    }
  }

  try {
    const accessToken = await getValidAccessToken(uid);
    const refreshed = await getStoredIntegration(uid);
    if (refreshed?.scope && integrationHasPrivateScope(refreshed.scope)) {
      return { hasPrivateScope: true, scope: refreshed.scope, needsReconnect: false };
    }
    if (await athleteCanReadPrivateActivities(accessToken)) {
      const scopes = new Set(parseStravaScopes(refreshed?.scope || scope));
      scopes.add("activity:read_all");
      const verified = [...scopes].join(",");
      await (await integrationRef(uid)).set(
        {
          scope: verified,
          privateActivityAccessVerified: true,
          scopeNormalizedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return { hasPrivateScope: true, scope: verified, needsReconnect: false };
    }
  } catch (e) {
    functions.logger.warn("resolvePrivateScopeForStatus", e.message);
  }

  return { hasPrivateScope: false, scope, needsReconnect: true };
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

function stravaRateLimitWaitMs(res, attempt) {
  const resetHeader = res.headers.get("x-ratelimit-reset") || res.headers.get("X-RateLimit-Reset");
  if (resetHeader) {
    const resetSec = Number(resetHeader);
    if (Number.isFinite(resetSec) && resetSec > 0) {
      const until = resetSec * 1000 - Date.now();
      if (until > 0) return Math.min(until, 120_000);
    }
  }
  const retryAfter = res.headers.get("retry-after") || res.headers.get("Retry-After");
  if (retryAfter) {
    const sec = Number(retryAfter);
    if (Number.isFinite(sec) && sec > 0) return Math.min(sec * 1000, 120_000);
  }
  return Math.min(15_000 * attempt, 60_000);
}

async function stravaFetch(path, accessToken, opts = {}) {
  const maxAttempts = Math.max(1, Number(opts.maxAttempts) || 3);
  let lastText = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetch(`${STRAVA_API}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 429 && attempt < maxAttempts) {
      const waitMs = stravaRateLimitWaitMs(res, attempt);
      functions.logger.warn("Strava 429, retry", { path, attempt, waitMs });
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) {
      lastText = await res.text();
      throw new Error(`Strava API ${res.status}: ${lastText.slice(0, 200)}`);
    }
    return res.json();
  }
  throw new Error(`Strava API 429: ${lastText.slice(0, 200) || "Rate Limit Exceeded"}`);
}

function isStravaRateLimitError(err) {
  const msg = err?.message || String(err);
  return /Strava API 429|Rate Limit Exceeded/i.test(msg);
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
    if (tok.scope) {
      data.scope = formatScopeString(tok.scope);
    }
    await ref.set(data, { merge: true });
  }
  return data.accessToken;
}

async function loadDataset(datasetId) {
  const bundle = await fetchDataJson(`${datasetId}.json`);
  return { datasetId, climbs: bundle.climbs || [], meta: bundle.meta || {} };
}

function isAllDatasetsToken(datasetId) {
  return datasetId === ALL_DATASETS_TOKEN;
}

async function loadRegionDatasetIds() {
  const index = await fetchDataJson("index.json");
  const ids = (index.regions || []).map((r) => String(r.id || "").trim()).filter(Boolean);
  return { ids, totalClimbs: index.total_climbs ?? null, regionCount: ids.length };
}

async function assertPrivateScopeIfNeeded(uid, prefs) {
  if (!prefs.includePrivate) return;
  const integration = await getStoredIntegration(uid);
  if (!integration) {
    throw new functions.https.HttpsError("failed-precondition", "Strava is niet gekoppeld.");
  }
  const scopeInfo = await resolvePrivateScopeForStatus(uid, integration, prefs);
  if (!scopeInfo.hasPrivateScope) {
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

const SYNC_SUMMARY_MATCH_LIMIT = 120;

function summaryMatchesFromMap(datasetId, bestByClimb) {
  const out = [];
  for (const [climbId, hit] of bestByClimb.entries()) {
    if (out.length >= SYNC_SUMMARY_MATCH_LIMIT) break;
    out.push({
      datasetId,
      climbId,
      climbName: hit.climbName || climbId,
      activityId: hit.activity.id,
      activityName: hit.activity.name || null,
    });
  }
  return out;
}

async function matchAndWriteForDatasets(uid, accessToken, activities, includePrivate, datasetIds) {
  let matchesWritten = 0;
  const datasetsProcessed = [];
  const matches = [];
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
      matches.push(...summaryMatchesFromMap(datasetId, bestByClimb));
    }
    datasetsProcessed.push(datasetId);
  }
  return { matchesWritten, datasetsProcessed, matches };
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
  const grantedScope = formatScopeString(tok.scope);

  await saveStravaIncludePrivate(uid, includePrivate);

  await (await integrationRef(uid)).set({
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: Date.now() + (tok.expires_in || 21600) * 1000,
    athleteId: athlete.id || null,
    athleteName: [athlete.firstname, athlete.lastname].filter(Boolean).join(" ") || null,
    scope: grantedScope,
    syncIncludePrivate: includePrivate,
    lastOAuthIncludePrivate: includePrivate,
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
    const scopeInfo =
      includePrivate && integration
        ? await resolvePrivateScopeForStatus(uid, integration, { includePrivate: true })
        : { needsReconnect: false };
    const needsReconnect = Boolean(scopeInfo.needsReconnect);
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
    const scopeInfo = await resolvePrivateScopeForStatus(uid, data, prefs);
    let activeSyncJob = null;
    try {
      activeSyncJob = await require("./stravaBackgroundSync").getActiveSyncJob(uid);
    } catch (e) {
      functions.logger.warn("getStravaStatus activeSyncJob", e);
    }
    return {
      connected: true,
      athleteName: data.athleteName || null,
      lastSyncAt: data.lastSyncAt?.toDate?.()?.toISOString?.() || null,
      lastSyncSummary: data.lastSyncSummary || null,
      includePrivate: prefs.includePrivate,
      hasPrivateScope: scopeInfo.hasPrivateScope,
      needsReconnect: scopeInfo.needsReconnect,
      grantedScope: scopeInfo.scope || null,
      fullSyncCursor: data.fullSyncCursor || null,
      activeSyncJob,
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
    let activityRecord = act;
    let poly = activityPolylineFromRecord(act);
    try {
      const detail = await stravaFetch(`/activities/${act.id}`, accessToken);
      if (!isCyclingActivity(detail)) continue;
      activityRecord = detail;
      poly = activityPolylineFromRecord(detail) || poly;
    } catch (e) {
      functions.logger.warn("activity detail skip", act.id, e.message);
      if (!isCyclingActivity(activityRecord) || !poly) continue;
    }
    if (!isCyclingActivity(activityRecord)) continue;
    if (!poly) continue;

    const candidates = climbsNearEncodedPolyline(climbs, poly);
    for (const climb of candidates) {
      const result = matchClimbToActivity(climb, poly);
      if (!result.matched) continue;
      const prev = bestByClimb.get(climb.id);
      if (!prev || result.coverage > prev.coverage) {
        bestByClimb.set(climb.id, {
          activity: activityRecord,
          coverage: result.coverage,
          climbName: climb.name || climb.title || String(climb.id),
        });
      }
    }
  }

  return { bestByClimb, ridesScanned: rides.length };
}

function logFieldTimestampMillis(v) {
  if (v == null) return 0;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v.toMillis === "function") return v.toMillis();
  return 0;
}

/** Ritdatum (lokaal bij voorkeur) als epoch-ms voor logboek-statistieken. */
function activityStartMillis(activity) {
  if (!activity) return null;
  const raw = activity.start_date_local || activity.start_date;
  if (!raw) return null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : null;
}

function buildStravaLogPatch(datasetId, climbId, hit, data, nowMs) {
  const doneUpdatedAt = logFieldTimestampMillis(data.doneUpdatedAt);
  const wishlistUpdatedAt = logFieldTimestampMillis(data.wishlistUpdatedAt);
  const newActivityId = hit.activity.id;
  const prevActivityId = data.stravaActivityId;
  let ascentCount = Number(data.stravaAscentCount) || 0;
  if (!prevActivityId) ascentCount = 1;
  else if (newActivityId !== prevActivityId) ascentCount += 1;

  const patch = {
    datasetId,
    climbId,
    stravaActivityId: newActivityId,
    stravaActivityName: hit.activity.name || null,
    stravaClimbName: hit.climbName || null,
    stravaAscentCount: ascentCount,
    matchCoverage: hit.coverage,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  const startAt = activityStartMillis(hit.activity);
  if (startAt != null) {
    patch.stravaActivityStartAt = startAt;
  }
  if (nowMs >= doneUpdatedAt) {
    patch.done = true;
    patch.doneUpdatedAt = startAt != null ? startAt : nowMs;
    patch.source = "strava";
  } else if (startAt != null && Boolean(data.done)) {
    // Al handmatig gedaan: Strava-ritdatum voor logboek/statistieken (jaar van de activiteit)
    patch.doneUpdatedAt = startAt;
    patch.source = "strava";
  }
  if (nowMs >= wishlistUpdatedAt) {
    patch.wishlist = false;
    patch.wishlistUpdatedAt = nowMs;
  }
  const nextDone = patch.done !== undefined ? patch.done : Boolean(data.done);
  const nextWishlist = patch.wishlist !== undefined ? patch.wishlist : Boolean(data.wishlist);
  if (!nextDone && !nextWishlist) {
    return { delete: true, patch: null };
  }
  return { delete: false, patch };
}

async function writeStravaMatches(uid, datasetId, bestByClimb) {
  const db = admin.firestore();
  const logCol = db.collection("users").doc(uid).collection("climbLog");
  const entries = [...bestByClimb.entries()];
  if (!entries.length) return;
  const nowMs = Date.now();
  const CHUNK = 100;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK);
    const refs = slice.map(([climbId]) => logCol.doc(logDocId(datasetId, climbId)));
    const snaps = await db.getAll(...refs);
    const batch = db.batch();
    for (let j = 0; j < slice.length; j += 1) {
      const [climbId, hit] = slice[j];
      const data = snaps[j].exists ? snaps[j].data() : {};
      const { delete: del, patch } = buildStravaLogPatch(datasetId, climbId, hit, data, nowMs);
      if (del) batch.delete(refs[j]);
      else batch.set(refs[j], patch, { merge: true });
    }
    await batch.commit();
  }
}

function parseActivityEpochBounds(data) {
  const afterMs = data?.after != null && data.after !== "" ? Number(data.after) : null;
  const beforeMs = data?.before != null && data.before !== "" ? Number(data.before) : null;
  const afterSec =
    afterMs != null && Number.isFinite(afterMs) ? Math.floor(afterMs / 1000) : null;
  const beforeSec =
    beforeMs != null && Number.isFinite(beforeMs) ? Math.floor(beforeMs / 1000) : null;
  if (afterSec != null && beforeSec != null && afterSec >= beforeSec) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Datum ‘tot’ moet na ‘van’ liggen."
    );
  }
  return { afterSec, beforeSec, afterMs, beforeMs };
}

function activityListQuery(page, perPage, bounds) {
  const params = new URLSearchParams();
  params.set("per_page", String(perPage));
  params.set("page", String(page));
  if (bounds?.afterSec != null) params.set("after", String(bounds.afterSec));
  if (bounds?.beforeSec != null) params.set("before", String(bounds.beforeSec));
  return `/athlete/activities?${params.toString()}`;
}

function activityPolylineFromRecord(activity) {
  const map = activity?.map;
  if (!map) return null;
  return map.polyline || map.summary_polyline || null;
}

async function fetchActivityPages(accessToken, { startPage, maxPages, perPage, afterSec, beforeSec }) {
  const bounds = { afterSec, beforeSec };
  const all = [];
  let page = Math.max(1, startPage);
  let pagesFetched = 0;
  let lastPageEmpty = false;
  while (pagesFetched < maxPages) {
    const chunk = await stravaFetch(activityListQuery(page, perPage, bounds), accessToken);
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
    const bounds = parseActivityEpochBounds(data);
    const prefs = await getStravaPrefs(uid);
    await assertPrivateScopeIfNeeded(uid, prefs);

    const accessToken = await getValidAccessToken(uid);
    let activities;
    if (bounds.afterSec != null || bounds.beforeSec != null) {
      const fetched = await fetchActivityPages(accessToken, {
        startPage: 1,
        maxPages: 40,
        perPage: 50,
        afterSec: bounds.afterSec,
        beforeSec: bounds.beforeSec,
      });
      activities = fetched.activities;
    } else {
      activities = await stravaFetch(activityListQuery(1, perPage, null), accessToken);
    }
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
        matches: result.matches.slice(0, SYNC_SUMMARY_MATCH_LIMIT),
        perPage,
        includePrivate: prefs.includePrivate,
        after: bounds.afterMs,
        before: bounds.beforeMs,
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
        matches: summaryMatchesFromMap(datasetId, bestByClimb),
        perPage,
        includePrivate: prefs.includePrivate,
        after: bounds.afterMs,
        before: bounds.beforeMs,
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
    const rangeNote =
      bounds.afterSec != null || bounds.beforeSec != null ? " (gefilterde periode)" : "";
    return {
      ok: true,
      message: `Proef-sync: ${matchesWritten} klim(men) gematcht (${scopeLabel}, ${ridesScanned} ritten${rangeNote}).`,
      summary,
    };
  });

exports.stravaSyncFull = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 300, memory: "1GB" })
  .https.onCall(async (data, context) => {
    try {
      return await stravaSyncFullHandler(data, context);
    } catch (e) {
      functions.logger.error("stravaSyncFull", e);
      if (e instanceof functions.https.HttpsError) throw e;
      const detail = e.message || String(e);
      if (/deadline|timeout|DEADLINE_EXCEEDED/i.test(detail)) {
        throw new functions.https.HttpsError(
          "deadline-exceeded",
          "Strava-sync duurde te lang in deze batch — klik opnieuw Volledige history sync (loopt verder)."
        );
      }
      throw new functions.https.HttpsError(
        "internal",
        `Strava volledige sync mislukt: ${detail}. Zie Firebase Functions-logs (stravaSyncFull).`
      );
    }
  });

/** Eén batch volledige Strava-sync (Phase 2 callable + Phase 3 worker). */
async function runStravaSyncBatch(uid, data) {
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
    const bounds = parseActivityEpochBounds(data);
    const integration = await getStoredIntegration(uid);
    const allMode = isAllDatasetsToken(datasetId);
    const accessToken = await getValidAccessToken(uid);

    function cursorBoundsMatch(cursor) {
      if (!cursor) return false;
      return (
        (cursor.afterSec ?? null) === (bounds.afterSec ?? null) &&
        (cursor.beforeSec ?? null) === (bounds.beforeSec ?? null)
      );
    }

    if (!allMode) {
      let startPage = 1;
      if (
        !reset &&
        integration?.fullSyncCursor?.mode !== "all" &&
        integration?.fullSyncCursor?.datasetId === datasetId &&
        integration.fullSyncCursor.nextPage &&
        cursorBoundsMatch(integration.fullSyncCursor)
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
        afterSec: bounds.afterSec,
        beforeSec: bounds.beforeSec,
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
        : {
            mode: "single",
            datasetId,
            nextPage,
            afterSec: bounds.afterSec,
            beforeSec: bounds.beforeSec,
            updatedAt: new Date().toISOString(),
          };

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
        matches: summaryMatchesFromMap(datasetId, bestByClimb),
        includePrivate: prefs.includePrivate,
        after: bounds.afterMs,
        before: bounds.beforeMs,
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
    if (!reset && prev?.mode === "all" && cursorBoundsMatch(prev)) {
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
        afterSec: bounds.afterSec,
        beforeSec: bounds.beforeSec,
      });

    const ridesScanned = countRideActivities(activities, prefs.includePrivate);
    const batchIds = regionIds.slice(nextDatasetIndex, nextDatasetIndex + datasetsPerCall);
    const { matchesWritten, datasetsProcessed, matches: batchMatches } = await matchAndWriteForDatasets(
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
        afterSec: bounds.afterSec,
        beforeSec: bounds.beforeSec,
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
      matches: batchMatches.slice(0, SYNC_SUMMARY_MATCH_LIMIT),
      includePrivate: prefs.includePrivate,
      after: bounds.afterMs,
      before: bounds.beforeMs,
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
}

async function stravaSyncFullHandler(data, context) {
  const uid = requireAuth(context);
  try {
    const bg = require("./stravaBackgroundSync");
    const active = await bg.getActiveSyncJob(uid);
    if (active && (active.status === "queued" || active.status === "running")) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Er loopt al een server-sync — wacht tot die klaar is of annuleer die eerst."
      );
    }
  } catch (e) {
    if (e instanceof functions.https.HttpsError) throw e;
    functions.logger.warn("stravaSyncFull active job check", e);
  }
  return runStravaSyncBatch(uid, data);
}

async function clearStravaLinkFromLogDoc(ref, row) {
  const wishlist = Boolean(row.wishlist);
  const done = Boolean(row.done);
  const stravaSourced = row.source === "strava";

  if (stravaSourced && done && !wishlist) {
    await ref.delete();
    return;
  }

  const patch = {
    stravaActivityId: admin.firestore.FieldValue.delete(),
    stravaActivityName: admin.firestore.FieldValue.delete(),
    stravaClimbName: admin.firestore.FieldValue.delete(),
    stravaAscentCount: admin.firestore.FieldValue.delete(),
    matchCoverage: admin.firestore.FieldValue.delete(),
    stravaActivityStartAt: admin.firestore.FieldValue.delete(),
  };
  if (stravaSourced && done) {
    patch.done = false;
    patch.source = "manual";
  }

  const nextDone = patch.done !== undefined ? patch.done : done;
  if (!nextDone && !wishlist) {
    await ref.delete();
    return;
  }
  await ref.set(patch, { merge: true });
}

exports.stravaCleanupLogMatches = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 300, memory: "1GB" })
  .https.onCall(async (data, context) => {
    const uid = requireAuth(context);
    const removeIndoor = data?.removeIndoor !== false;
    const revalidateRoutes = data?.revalidateRoutes !== false;
    const accessToken = await getValidAccessToken(uid);

    const logCol = admin.firestore().collection("users").doc(uid).collection("climbLog");
    const snap = await logCol.get();
    const entries = [];
    snap.forEach((doc) => {
      const row = doc.data();
      if (row?.stravaActivityId) {
        entries.push({ ref: doc.ref, row });
      }
    });

    const activityCache = new Map();
    const datasetCache = new Map();
    let removedIndoor = 0;
    let removedWeak = 0;
    let kept = 0;
    let fetchErrors = 0;

    async function getActivity(actId) {
      if (activityCache.has(actId)) return activityCache.get(actId);
      try {
        const act = await stravaFetch(`/activities/${actId}`, accessToken);
        activityCache.set(actId, act);
        return act;
      } catch (e) {
        functions.logger.warn("stravaCleanupLogMatches activity", actId, e.message);
        activityCache.set(actId, null);
        return null;
      }
    }

    async function getClimb(datasetId, climbId) {
      if (!datasetCache.has(datasetId)) {
        try {
          datasetCache.set(datasetId, await loadDataset(datasetId));
        } catch (e) {
          functions.logger.warn("stravaCleanupLogMatches dataset", datasetId, e.message);
          datasetCache.set(datasetId, null);
        }
      }
      const bundle = datasetCache.get(datasetId);
      if (!bundle) return null;
      return (bundle.climbs || []).find((c) => String(c.id) === String(climbId));
    }

    for (const { ref, row } of entries) {
      const act = await getActivity(row.stravaActivityId);
      if (!act) {
        fetchErrors += 1;
        continue;
      }

      let remove = false;
      if (removeIndoor && !isCyclingActivity(act)) {
        remove = true;
        removedIndoor += 1;
      } else if (revalidateRoutes) {
        const climb = await getClimb(row.datasetId, row.climbId);
        const poly = activityPolylineFromRecord(act);
        if (!climb || !poly) {
          remove = true;
          removedWeak += 1;
        } else {
          const result = matchClimbToActivity(climb, poly);
          if (!result.matched) {
            remove = true;
            removedWeak += 1;
          }
        }
      }

      if (remove) {
        await clearStravaLinkFromLogDoc(ref, row);
      } else {
        kept += 1;
        const startAt = activityStartMillis(act);
        if (startAt != null && !logFieldTimestampMillis(row.stravaActivityStartAt)) {
          await ref.set({ stravaActivityStartAt: startAt }, { merge: true });
        }
      }
    }

    const parts = [];
    if (removedIndoor) parts.push(`${removedIndoor} indoor/simulator`);
    if (removedWeak) parts.push(`${removedWeak} losse route-match`);
    const summary = parts.length ? parts.join(", ") + " verwijderd" : "niets verwijderd";

    return {
      ok: true,
      scanned: entries.length,
      kept,
      removedIndoor,
      removedWeak,
      fetchErrors,
      message: `Opschoning: ${summary}; ${kept} koppeling(en) behouden.`,
    };
  });

exports.ALL_DATASETS_TOKEN = ALL_DATASETS_TOKEN;
exports.runStravaSyncBatch = runStravaSyncBatch;
exports.isStravaRateLimitError = isStravaRateLimitError;
Object.assign(exports, require("./stravaBackgroundSync"));
