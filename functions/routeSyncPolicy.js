/**
 * Route-based climb matching: prefer CPL stored polylines over Strava API (no 429).
 */
const functions = require("firebase-functions");
const { resolveCplOwnerByEmail, cplCfg } = require("./cplClient");

const ALL_DATASETS_TOKEN = "__all__";

function preferCplRouteSyncConfig() {
  const cpl = cplCfg();
  if (cpl.prefer_route_sync === "false" || cpl.prefer_route_sync === false) return false;
  return true;
}

function cplWorkerConfigured() {
  return Boolean(cplCfg().worker_secret);
}

/**
 * Hele-database server-sync mag CPL-routes + climbMatch gebruiken i.p.v. Strava API.
 * @param {string} email
 */
async function preferFullDatabaseRouteSyncViaCpl(email) {
  if (!preferCplRouteSyncConfig() || !cplWorkerConfigured()) return false;
  try {
    const owner = await resolveCplOwnerByEmail(email);
    return Boolean(owner?.uid);
  } catch (e) {
    functions.logger.warn("preferFullDatabaseRouteSyncViaCpl", e?.message || e);
    return false;
  }
}

function isAllDatasetsToken(datasetId) {
  return String(datasetId || "").trim() === ALL_DATASETS_TOKEN;
}

module.exports = {
  ALL_DATASETS_TOKEN,
  preferCplRouteSyncConfig,
  cplWorkerConfigured,
  preferFullDatabaseRouteSyncViaCpl,
  isAllDatasetsToken,
};
