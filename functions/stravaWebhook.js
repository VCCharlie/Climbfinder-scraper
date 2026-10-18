/**
 * Strava push subscriptions: verify + enqueue incremental sync hints (no per-event Strava API storm).
 */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const REGION = "europe-west1";
const EVENT_COLLECTION = "stravaWebhookEvents";

function stravaCfg() {
  return functions.config().strava || {};
}

function webhookVerifyToken() {
  const t = stravaCfg().webhook_verify_token;
  return t && String(t).trim() ? String(t).trim() : null;
}

function integrationRef(uid) {
  return admin.firestore().collection("users").doc(uid).collection("integrations").doc("strava");
}

async function findUidForAthleteId(athleteId) {
  const id = Number(athleteId);
  if (!Number.isFinite(id)) return null;
  const snap = await admin
    .firestore()
    .collectionGroup("integrations")
    .where("athleteId", "==", id)
    .limit(3)
    .get();
  for (const doc of snap.docs) {
    if (doc.id !== "strava") continue;
    const parts = doc.ref.path.split("/");
    const uidIdx = parts.indexOf("users");
    if (uidIdx >= 0 && parts[uidIdx + 1]) return parts[uidIdx + 1];
  }
  return null;
}

async function recordWebhookEvent(payload) {
  const ref = admin.firestore().collection(EVENT_COLLECTION).doc();
  await ref.set({
    ...payload,
    receivedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
}

async function enqueueUserWebhookHint(uid, event) {
  const integRef = integrationRef(uid);
  const pending = {
    objectType: event.object_type || null,
    objectId: event.object_id != null ? String(event.object_id) : null,
    aspectType: event.aspect_type || null,
    eventTime: event.event_time || null,
    ownerId: event.owner_id || null,
    receivedAtMs: Date.now(),
  };
  await integRef.set(
    {
      webhookPending: pending,
      webhookPendingAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

exports.stravaWebhookHttp = functions
  .region(REGION)
  .https.onRequest(async (req, res) => {
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];
      const expected = webhookVerifyToken();
      if (mode === "subscribe" && expected && token === expected && challenge) {
        res.status(200).json({ "hub.challenge": challenge });
        return;
      }
      res.status(403).send("Forbidden");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const body = req.body || {};
    try {
      const eventId = await recordWebhookEvent({
        object_type: body.object_type,
        object_id: body.object_id,
        aspect_type: body.aspect_type,
        owner_id: body.owner_id,
        event_time: body.event_time,
        subscription_id: body.subscription_id,
      });

      const uid = await findUidForAthleteId(body.owner_id);
      if (uid && (body.object_type === "activity" || body.object_type === "athlete")) {
        await enqueueUserWebhookHint(uid, body);
        if (body.object_type === "activity") {
          try {
            const cplBg = require("./cplBackgroundSync");
            const enq = await cplBg.enqueueIncrementalCplFromWebhook(uid, body);
            functions.logger.info("stravaWebhook cplEnqueue", { uid, enq });
          } catch (e) {
            functions.logger.warn("stravaWebhook cplEnqueue failed", e?.message || e);
          }
        }
      }

      functions.logger.info("stravaWebhook", { eventId, uid, object_type: body.object_type });
      res.status(200).json({ ok: true });
    } catch (e) {
      functions.logger.error("stravaWebhook", e);
      res.status(500).json({ ok: false });
    }
  });

/**
 * One-time admin: create Strava push subscription (callable, allowed email only).
 */
exports.stravaRegisterWebhook = functions.region(REGION).https.onCall(async (_data, context) => {
  const cfgAuth = functions.config().auth || {};
  const list = (cfgAuth.allowed_emails || "vr.deruiter@gmail.com")
    .split(",")
    .map((s) => s.trim().toLowerCase());
  const email = context.auth?.token?.email;
  if (!email || !list.includes(email.trim().toLowerCase())) {
    throw new functions.https.HttpsError("permission-denied", "Geen toegang.");
  }

  const c = stravaCfg();
  const clientId = c.client_id;
  const clientSecret = c.client_secret;
  const callbackUrl = c.webhook_callback_url;
  const verifyToken = webhookVerifyToken();
  if (!clientId || !clientSecret || !callbackUrl || !verifyToken) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "strava.client_id, client_secret, webhook_callback_url, webhook_verify_token vereist."
    );
  }

  const res = await fetch("https://www.strava.com/api/v3/push_subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      callback_url: callbackUrl,
      verify_token: verifyToken,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new functions.https.HttpsError("internal", `Strava subscription ${res.status}: ${text.slice(0, 300)}`);
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { ok: true, subscription: json };
});

/** Clear webhook hint after UI/CPL handled the event (avoids repeat auto-sync). */
exports.stravaAckWebhookPending = functions.region(REGION).https.onCall(async (_data, context) => {
  if (!context.auth?.uid) {
    throw new functions.https.HttpsError("unauthenticated", "Log in.");
  }
  const uid = context.auth.uid;
  await integrationRef(uid).set(
    {
      webhookPending: admin.firestore.FieldValue.delete(),
      webhookPendingAt: admin.firestore.FieldValue.delete(),
      webhookAckAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return { ok: true };
});
