/** Match CPL / stored activity polylines against climb datasets (no Strava API). */
const { isCyclingActivity, climbsNearEncodedPolyline } = require("./climbMatch");
const { matchStoredActivitiesToClimbs } = require("./syncPipeline");

function activityVisibleForPrefs(activity) {
  if (!activity) return false;
  if (activity.private === true) return false;
  return true;
}

function polylineStringFromMapField(raw) {
  if (raw == null) return null;
  if (typeof raw === "object" && raw.summary_polyline) {
    const s = String(raw.summary_polyline).trim();
    return s || null;
  }
  const s = String(raw).trim();
  if (!s || s === "[object Object]") return null;
  return s;
}

/** @param {'default'|'intervals_only'|'strava_only'} [routeMapPolicy] */
function encodedPolylineFromCplData(data, routeMapPolicy = "default") {
  const policy = routeMapPolicy === "intervals_only" || routeMapPolicy === "strava_only"
    ? routeMapPolicy
    : "default";
  if (policy === "intervals_only") {
    return polylineStringFromMapField(data?.intervals_map);
  }
  if (policy === "strava_only") {
    return polylineStringFromMapField(data?.strava_map);
  }
  const fromIntervals = polylineStringFromMapField(data?.intervals_map);
  if (fromIntervals) return fromIntervals;
  const fromStrava = polylineStringFromMapField(data?.strava_map);
  if (fromStrava) return fromStrava;
  const fromRootMap = polylineStringFromMapField(data?.map);
  if (fromRootMap) return fromRootMap;
  const overview = data?.map?.overview_polyline;
  if (overview != null) {
    const s = String(overview).trim();
    if (s) return s;
  }
  const poly = data?.polyline ?? data?.summary_polyline ?? data?.route_polyline;
  if (poly != null) {
    const s = String(poly).trim();
    if (s && s !== "[object Object]") return s;
  }
  return null;
}

function distanceMetersFromCpl(data) {
  const km = Number(data?.distance_km ?? data?.distance);
  if (Number.isFinite(km) && km > 0) {
    if (km < 600) return Math.round(km * 1000);
    return Math.round(km);
  }
  const m = Number(data?.distance_m ?? data?.icu_distance);
  if (Number.isFinite(m) && m > 0) return Math.round(m);
  return null;
}

/**
 * @param {string} docId
 * @param {object} data — CPL Firestore activity row
 */
function cplActivityToMatchRecord(docId, data, routeMapPolicy = "default") {
  const id = String(docId || data?.id || "").trim();
  const poly = encodedPolylineFromCplData(data, routeMapPolicy);
  const dateRaw = data?.date || data?.start_date_local || data?.start_date || null;
  const startLocal =
    dateRaw && String(dateRaw).includes("T")
      ? String(dateRaw)
      : dateRaw
        ? `${String(dateRaw).slice(0, 10)}T12:00:00`
        : null;
  const sport = data?.type || data?.sport_type || "Ride";
  const distM = distanceMetersFromCpl(data);
  const stravaId = data?.strava_id != null ? String(data.strava_id).replace(/\D/g, "") : null;

  return {
    id,
    cplActivityId: id,
    name: data?.title || data?.name || `CPL ${id}`,
    sport_type: sport,
    type: sport,
    trainer: data?.trainer === true,
    start_date_local: startLocal,
    start_date: startLocal,
    distance: distM,
    private: false,
    map: poly ? { summary_polyline: poly } : undefined,
    strava_id: stravaId || undefined,
    _cplSource: true,
  };
}

function summaryMatchesFromMap(datasetId, bestByClimb, limit = 120) {
  const out = [];
  for (const [climbId, hit] of bestByClimb.entries()) {
    if (out.length >= limit) break;
    out.push({
      datasetId,
      climbId,
      climbName: hit.climbName || climbId,
      activityId: hit.activity.cplActivityId || hit.activity.id,
      cplActivityId: hit.activity.cplActivityId || hit.activity.id,
      activityName: hit.activity.name || null,
    });
  }
  return out;
}

module.exports = {
  cplActivityToMatchRecord,
  encodedPolylineFromCplData,
  matchStoredActivitiesToClimbs,
  summaryMatchesFromMap,
};
