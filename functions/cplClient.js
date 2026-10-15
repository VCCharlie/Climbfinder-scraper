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

/**
 * @param {string} email
 * @returns {Promise<{ uid: string, email: string } | null>}
 */
async function resolveCplOwnerByEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;
  try {
    const user = await getCplAuth().getUserByEmail(normalized);
    return { uid: user.uid, email: user.email || normalized };
  } catch (e) {
    if (e?.code === "auth/user-not-found") return null;
    functions.logger.warn("resolveCplOwnerByEmail", e?.message || e);
    throw e;
  }
}

module.exports = {
  cplCfg,
  cplProjectId,
  getCplFirestore,
  getCplAuth,
  cplSyncConfigured,
  resolveCplOwnerByEmail,
};
