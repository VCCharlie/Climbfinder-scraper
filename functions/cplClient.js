/**
 * Cross-project read: Climb Performance Lab Firestore + Auth (same Google email → CPL ownerId).
 */
const functions = require("firebase-functions");
const admin = require("firebase-admin");

const CPL_APP_NAME = "climb-performance-lab";

function cplCfg() {
  return functions.config().cpl || {};
}

function cplProjectId() {
  return cplCfg().project_id || "climb-performance-lab";
}

function getCplApp() {
  const existing = admin.apps.find((a) => a && a.name === CPL_APP_NAME);
  if (existing) return existing;
  return admin.initializeApp({ projectId: cplProjectId() }, CPL_APP_NAME);
}

function getCplFirestore() {
  return admin.firestore(getCplApp());
}

function getCplAuth() {
  return admin.auth(getCplApp());
}

function cplSyncConfigured() {
  return Boolean(cplCfg().worker_secret || cplCfg().enabled);
}

function normalizeEmail(email) {
  const s = String(email || "").trim().toLowerCase();
  return s || null;
}

/** @param {import("firebase-functions").https.CallableContext["auth"]} auth */
function googleProviderUidFromAuth(auth) {
  const ids = auth?.token?.firebase?.identities?.["google.com"];
  if (!Array.isArray(ids) || !ids[0]) return null;
  return String(ids[0]);
}

/** @param {import("firebase-functions").https.CallableContext} context */
function authIdentityFromContext(context) {
  const token = context.auth?.token;
  return {
    email: normalizeEmail(token?.email),
    googleUid: googleProviderUidFromAuth(context.auth),
  };
}

/**
 * @param {string} email
 * @returns {Promise<{ uid: string, email: string, matchedVia: string } | null>}
 */
async function resolveCplOwnerByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  try {
    const user = await getCplAuth().getUserByEmail(normalized);
    return {
      uid: user.uid,
      email: user.email || normalized,
      matchedVia: "email",
    };
  } catch (e) {
    if (e?.code === "auth/user-not-found") return null;
    functions.logger.warn("resolveCplOwnerByEmail", e?.message || e);
    throw e;
  }
}

/**
 * Match FietsKlim Google login to CPL Firebase Auth (email, else google.com provider uid).
 * @param {{ email?: string|null, googleUid?: string|null }} identity
 */
async function resolveCplOwner(identity = {}) {
  const email = normalizeEmail(identity.email);
  if (email) {
    const byEmail = await resolveCplOwnerByEmail(email);
    if (byEmail) return byEmail;
  }
  const googleUid = identity.googleUid ? String(identity.googleUid) : null;
  if (googleUid) {
    try {
      const user = await getCplAuth().getUserByProviderUid("google.com", googleUid);
      return {
        uid: user.uid,
        email: normalizeEmail(user.email) || email,
        matchedVia: "google_uid",
      };
    } catch (e) {
      if (e?.code === "auth/user-not-found") return null;
      functions.logger.warn("resolveCplOwner google_uid", e?.message || e);
      throw e;
    }
  }
  return null;
}

/** @param {import("firebase-functions").https.CallableContext} context */
async function resolveCplOwnerFromContext(context) {
  if (!context.auth) return null;
  return resolveCplOwner(authIdentityFromContext(context));
}

module.exports = {
  cplCfg,
  cplProjectId,
  getCplFirestore,
  getCplAuth,
  cplSyncConfigured,
  normalizeEmail,
  googleProviderUidFromAuth,
  authIdentityFromContext,
  resolveCplOwnerByEmail,
  resolveCplOwner,
  resolveCplOwnerFromContext,
};
