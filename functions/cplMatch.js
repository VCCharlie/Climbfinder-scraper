/** Match CPL / stored activity polylines against climb datasets (no Strava API). */
const { matchClimbToActivity, isCyclingActivity, climbsNearEncodedPolyline } = require("./climbMatch");

function activityVisibleForPrefs(activity) {
  if (!activity) return false;
  if (activity.private === true) return false;
  return true;
}

function encodedPolylineFromCplData(data) {
  const raw = data?.intervals_map || data?.strava_map;
  if (raw == null) return null;
  const s = String(raw).trim();
  return s || null;
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
function cplActivityToMatchRecord(docId, data) {
  const id = String(docId || data?.id || "").trim();
  const poly = encodedPolylineFromCplData(data);
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

function polylineFromMatchActivity(activity) {
  const map = activity?.map;
  if (!map) return null;
  return map.summary_polyline || map.polyline || null;
}

/**
 * @param {{ climbs: object[], activities: object[], includePrivate?: boolean }} params
 */
function matchStoredActivitiesToClimbs({ climbs, activities, includePrivate = true }) {
  const rides = (activities || [])
    .filter(isCyclingActivity)
    .filter((act) => includePrivate || activityVisibleForPrefs(act));

  /** @type {Map<string, { activity: object, coverage: number, climbName: string }>} */
  const bestByClimb = new Map();

  for (const act of rides) {
    const poly = polylineFromMatchActivity(act);
    if (!poly) continue;
    const candidates = climbsNearEncodedPolyline(climbs, poly);
    for (const climb of candidates) {
      const result = matchClimbToActivity(climb, poly);
      if (!result.matched) continue;
      const climbId = climb.id;
      const prev = bestByClimb.get(climbId);
      const climbName = climb.name || climb.title || String(climbId);
      if (!prev || result.coverage > prev.coverage) {
        bestByClimb.set(climbId, {
          activity: act,
          coverage: result.coverage,
          climbName,
        });
      }
    }
  }

  return { bestByClimb, ridesScanned: rides.length };
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
