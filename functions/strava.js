const functions = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");
const { matchClimbToActivity, isCyclingActivity } = require("./climbMatch");

const REGION = "europe-west1";
const STRAVA_AUTH = "https://www.strava.com/oauth/authorize";
const STRAVA_TOKEN = "https://www.strava.com/oauth/token";
const STRAVA_API = "https://www.strava.com/api/v3";
const SCOPES = "read,activity:read";
const STATE_TTL_MS = 15 * 60 * 1000;
const TRIAL_ACTIVITY_COUNT = 50;

function stravaCfg() {
  return functions.config().strava || {};
}

function siteReturnUrl() {
  return (
    stravaCfg().site_return_url ||
    "https://vccharlie.github.io/Climbfinder-scraper/climbs/index.html"
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
  if (!u) {
    throw new Error("strava.redirect_uri ontbreekt in Functions config");
  }
  return u;
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

exports.getStravaConnectUrl = functions.region(REGION).https.onCall(async (_data, context) => {
  const uid = requireAuth(context);
  const clientId = stravaCfg().client_id;
  if (!clientId) {
    throw new functions.https.HttpsError("failed-precondition", "Strava client_id niet geconfigureerd.");
  }

  const state = crypto.randomBytes(24).toString("hex");
  await admin.firestore().collection("stravaOAuthStates").doc(state).set({
    uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    approval_prompt: "auto",
    scope: SCOPES,
    state,
  });

  return { url: `${STRAVA_AUTH}?${params.toString()}` };
});

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

    const stateRef = admin.firestore().collection("stravaOAuthStates").doc(state);
    const stateSnap = await stateRef.get();
    if (!stateSnap.exists) {
      res.status(400).send("Ongeldige of verlopen state");
      return;
    }
    const { uid, createdAt } = stateSnap.data();
    await stateRef.delete();

    if (createdAt?.toMillis && Date.now() - createdAt.toMillis() > STATE_TTL_MS) {
      res.status(400).send("State verlopen");
      return;
    }

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
      res.redirect(302, `${siteReturnUrl()}?strava=token_error`);
      return;
    }
    const tok = await tokRes.json();
    const athlete = tok.athlete || {};

    await (await integrationRef(uid)).set({
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: Date.now() + (tok.expires_in || 21600) * 1000,
      athleteId: athlete.id || null,
      athleteName: [athlete.firstname, athlete.lastname].filter(Boolean).join(" ") || null,
      scope: SCOPES,
      connectedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastSyncAt: null,
      lastSyncSummary: null,
    });

    res.redirect(302, `${siteReturnUrl()}?strava=connected`);
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
  const data = await getStoredIntegration(uid);
  if (!data) {
    return { connected: false };
  }
  return {
    connected: true,
    athleteName: data.athleteName || null,
    lastSyncAt: data.lastSyncAt?.toDate?.()?.toISOString?.() || null,
    lastSyncSummary: data.lastSyncSummary || null,
  };
});

exports.stravaSyncTrial = functions.region(REGION).https.onCall(async (data, context) => {
  const uid = requireAuth(context);
  const datasetId = String(data.datasetId || "nl-limburg").trim();
  const perPage = Math.min(Number(data.perPage) || TRIAL_ACTIVITY_COUNT, 50);

  const accessToken = await getValidAccessToken(uid);
  const { climbs } = await loadDataset(datasetId);
  if (!climbs.length) {
    throw new functions.https.HttpsError("not-found", `Geen klimmen in ${datasetId}`);
  }

  const activities = await stravaFetch(
    `/athlete/activities?per_page=${perPage}&page=1`,
    accessToken
  );
  const rides = (activities || []).filter(isCyclingActivity);

  const db = admin.firestore();
  const logCol = db.collection("users").doc(uid).collection("climbLog");
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

    for (const climb of climbs) {
      const result = matchClimbToActivity(climb, poly);
      if (!result.matched) continue;
      const prev = bestByClimb.get(climb.id);
      if (!prev || result.coverage > prev.coverage) {
        bestByClimb.set(climb.id, { activity: act, coverage: result.coverage });
      }
    }
  }

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

  const summary = {
    datasetId,
    activitiesScanned: rides.length,
    matchesWritten: bestByClimb.size,
    uniqueClimbs: bestByClimb.size,
    perPage,
  };

  await (await integrationRef(uid)).set(
    {
      lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
      lastSyncSummary: summary,
    },
    { merge: true }
  );

  return {
    ok: true,
    message: `Proef-sync: ${summary.uniqueClimbs} klim(men) gematcht in ${datasetId} (${rides.length} ritten).`,
    summary,
  };
});
