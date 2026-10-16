/**
 * Route-based climb matching: prefer CPL stored polylines over Strava API (no 429).
 */
const functions = require("firebase-functions");
const { resolveCplOwnerFromContext, cplCfg } = require("./cplClient");

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
 * @param {import("firebase-functions").https.CallableContext} context
 */
async function preferFullDatabaseRouteSyncViaCpl(context) {
  if (!preferCplRouteSyncConfig() || !cplWorkerConfigured()) return false;
  try {
    const owner = await resolveCplOwnerFromContext(context);
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
