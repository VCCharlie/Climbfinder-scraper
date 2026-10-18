/**
 * Activity → climb matching pipeline: minimal Strava API reads, spatial pre-filter, detection-biased opts.
 */
const admin = require("firebase-admin");
const {
  matchClimbToActivity,
  isCyclingActivity,
  climbsNearEncodedPolyline,
  DEFAULT_MATCH_OPTS,
  DETECTION_MATCH_OPTS,
} = require("./climbMatch");
const { buildClimbSpatialIndex } = require("./climbSpatialIndex");
const {
  polylineFingerprint,
  datasetRevisionFingerprint,
  loadMatchFingerprintMap,
  shouldSkipActivityMatch,
  writeMatchFingerprints,
} = require("./activityMatchFingerprint");

const DEFAULT_MIN_GAP_MS = 220;

function activityPolylineFromRecord(activity) {
  const map = activity?.map;
  if (!map) return null;
  return map.polyline || map.summary_polyline || null;
}

/**
 * Adaptive spacing between Strava detail fetches (list payload often already has summary_polyline).
 */
function createStravaReadScheduler(minGapMs = DEFAULT_MIN_GAP_MS) {
  let lastAt = 0;
  return async function pace() {
    const now = Date.now();
    const wait = Math.max(0, lastAt + minGapMs - now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
  };
}

/**
 * @returns {Promise<{ activity: object, poly: string|null, stravaDetailReads: number }>}
 */
async function resolveStravaActivityPolyline(act, accessToken, stravaFetch, pace) {
  let activityRecord = act;
  let poly = activityPolylineFromRecord(act);
  if (poly) {
    return { activity: activityRecord, poly, stravaDetailReads: 0 };
  }
  if (!accessToken || !stravaFetch || !act?.id) {
    return { activity: activityRecord, poly: null, stravaDetailReads: 0 };
  }
  await pace();
  const detail = await stravaFetch(`/activities/${act.id}`, accessToken);
  activityRecord = detail;
  poly = activityPolylineFromRecord(detail);
  return { activity: activityRecord, poly, stravaDetailReads: 1 };
}

function activityVisibleForPrefs(activity, includePrivate) {
  if (!activity) return false;
  if (!includePrivate && activity.private === true) return false;
  return true;
}

function ensureSpatialIndex(climbs, spatialIndex) {
  if (spatialIndex) return spatialIndex;
  return buildClimbSpatialIndex(climbs);
}

function candidatesNearPolyline(climbs, encodedPolyline, spatialIndex, padM) {
  const index = ensureSpatialIndex(climbs, spatialIndex);
  return climbsNearEncodedPolyline(climbs, encodedPolyline, padM, index);
}

/**
 * Strava-backed matching (skips detail API when summary polyline present).
 * @param {object} params
 * @param {string|null} [params.uid] — when set, enables fingerprint skip + persistence
 * @param {string|null} [params.datasetId]
 * @param {object|null} [params.datasetMeta]
 */
async function matchActivitiesToClimbs({
  accessToken,
  climbs,
  spatialIndex,
  activities,
  includePrivate,
  stravaFetch,
  matchOpts = DETECTION_MATCH_OPTS,
  uid = null,
  datasetId = null,
  datasetMeta = null,
  minStravaGapMs = DEFAULT_MIN_GAP_MS,
}) {
  const rides = (activities || [])
    .filter(isCyclingActivity)
    .filter((act) => activityVisibleForPrefs(act, includePrivate));

  const pace = createStravaReadScheduler(minStravaGapMs);
  const padM = matchOpts.bboxPadM ?? DEFAULT_MATCH_OPTS.bboxPadM;
  const index = ensureSpatialIndex(climbs, spatialIndex);

  const datasetRev =
    uid && datasetId ? datasetRevisionFingerprint(datasetMeta, datasetId) : null;
  let fingerprintMap = new Map();
  if (uid && datasetId && datasetRev) {
    fingerprintMap = await loadMatchFingerprintMap(
      admin.firestore(),
      uid,
      datasetId,
      rides.map((a) => a.id)
    );
  }

  /** @type {Map<string, { activity: object, coverage: number, climbName?: string }>} */
  const bestByClimb = new Map();
  let stravaDetailReads = 0;
  const fingerprintWrites = [];

  for (const act of rides) {
    const { activity: activityRecord, poly, stravaDetailReads: reads } =
      await resolveStravaActivityPolyline(act, accessToken, stravaFetch, pace);
    stravaDetailReads += reads;
    if (!isCyclingActivity(activityRecord)) continue;
    if (!poly) continue;

    const polyHash = polylineFingerprint(poly);
    if (
      uid &&
      datasetId &&
      datasetRev &&
      shouldSkipActivityMatch(fingerprintMap.get(String(act.id)), polyHash, datasetRev)
    ) {
      fingerprintWrites.push({
        activityId: act.id,
        polylineHash: polyHash,
        datasetRev,
        skippedMatch: true,
        matchesFound: 0,
      });
      continue;
    }

    const candidates = candidatesNearPolyline(climbs, poly, index, padM);
    let hits = 0;
    for (const climb of candidates) {
      const result = matchClimbToActivity(climb, poly, matchOpts);
      if (!result.matched) continue;
      hits += 1;
      const prev = bestByClimb.get(climb.id);
      if (!prev || result.coverage > prev.coverage) {
        bestByClimb.set(climb.id, {
          activity: activityRecord,
          coverage: result.coverage,
          climbName: climb.name || climb.title || String(climb.id),
        });
      }
    }

    if (uid && datasetId && datasetRev && polyHash) {
      fingerprintWrites.push({
        activityId: act.id,
        polylineHash: polyHash,
        datasetRev,
        skippedMatch: hits === 0,
        matchesFound: hits,
      });
    }
  }

  if (uid && datasetId && fingerprintWrites.length) {
    await writeMatchFingerprints(admin.firestore(), uid, datasetId, fingerprintWrites);
  }

  return { bestByClimb, ridesScanned: rides.length, stravaDetailReads };
}

/**
 * CPL / stored polyline path (no Strava API).
 */
function matchStoredActivitiesToClimbs({
  climbs,
  spatialIndex,
  activities,
  includePrivate = true,
  matchOpts = DETECTION_MATCH_OPTS,
}) {
  const rides = (activities || [])
    .filter(isCyclingActivity)
    .filter((act) => includePrivate || activityVisibleForPrefs(act, true));

  const padM = matchOpts.bboxPadM ?? DEFAULT_MATCH_OPTS.bboxPadM;
  const index = ensureSpatialIndex(climbs, spatialIndex);

  /** @type {Map<string, { activity: object, coverage: number, climbName: string }>} */
  const bestByClimb = new Map();

  for (const act of rides) {
    const poly = activityPolylineFromRecord(act);
    if (!poly) continue;
    const candidates = candidatesNearPolyline(climbs, poly, index, padM);
    for (const climb of candidates) {
      const result = matchClimbToActivity(climb, poly, matchOpts);
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

module.exports = {
  activityPolylineFromRecord,
  createStravaReadScheduler,
  resolveStravaActivityPolyline,
  matchActivitiesToClimbs,
  matchStoredActivitiesToClimbs,
  DETECTION_MATCH_OPTS,
};
