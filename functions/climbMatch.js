/** Match Strava activity polylines against climb LineStrings (GeoJSON lon/lat). */

const EARTH_R = 6371000;

function haversineM(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Google encoded polyline → [[lat, lon], …] */
function decodePolyline(encoded) {
  if (!encoded) return [];
  const coords = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    let b;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;
    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlon = result & 1 ? ~(result >> 1) : result >> 1;
    lon += dlon;
    coords.push([lat / 1e5, lon / 1e5]);
  }
  return coords;
}

function climbCoordsLonLat(climb) {
  const g = climb.geometry;
  if (!g || g.type !== "LineString" || !Array.isArray(g.coordinates)) return [];
  return g.coordinates.map(([lon, lat]) => [lat, lon]);
}

function bboxFromCoords(coords) {
  if (!coords.length) return null;
  let minLat = coords[0][0];
  let maxLat = coords[0][0];
  let minLon = coords[0][1];
  let maxLon = coords[0][1];
  for (const [lat, lon] of coords) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }
  return { minLat, maxLat, minLon, maxLon };
}

function bboxesOverlap(a, b, padDeg = 0.02) {
  if (!a || !b) return true;
  return !(
    a.maxLat + padDeg < b.minLat - padDeg ||
    a.minLat - padDeg > b.maxLat + padDeg ||
    a.maxLon + padDeg < b.minLon - padDeg ||
    a.minLon - padDeg > b.maxLon + padDeg
  );
}

function pointToSegmentDistM(px, py, ax, ay, bx, by) {
  const ab = haversineM(ax, ay, bx, by);
  if (ab < 1e-3) return haversineM(px, py, ax, ay);
  const ap = haversineM(ax, ay, px, py);
  const bp = haversineM(bx, by, px, py);
  const s = (ap + bp + ab) / 2;
  const area = Math.sqrt(Math.max(0, s * (s - ap) * (s - bp) * (s - ab)));
  const h = (2 * area) / ab;
  return Number.isFinite(h) ? h : Math.min(ap, bp);
}

function minDistToTrackM(lat, lon, track) {
  let best = Infinity;
  for (let i = 0; i < track.length - 1; i++) {
    const [aLat, aLon] = track[i];
    const [bLat, bLon] = track[i + 1];
    best = Math.min(best, pointToSegmentDistM(lat, lon, aLat, aLon, bLat, bLon));
  }
  return best;
}

function cumulativeDistancesM(coords) {
  const d = [0];
  for (let i = 1; i < coords.length; i++) {
    d.push(d[i - 1] + haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
  }
  return d;
}

/** Standaard match-parameters (strakker dan v1 — minder parallelweg/false positives). */
const DEFAULT_MATCH_OPTS = {
  bufferM: 30,
  minCoverage: 0.78,
  sampleStepM: 25,
  bboxPadDeg: 0.008,
  endpointMaxM: 55,
  maxMeanSampleDistM: 70,
};

/**
 * @param {object} climb — climb JSON with geometry
 * @param {string} encodedPolyline — Strava summary polyline
 * @param {{ bufferM?: number, minCoverage?: number, sampleStepM?: number }} opts
 */
function matchClimbToActivity(climb, encodedPolyline, opts = {}) {
  const bufferM = opts.bufferM ?? DEFAULT_MATCH_OPTS.bufferM;
  const minCoverage = opts.minCoverage ?? DEFAULT_MATCH_OPTS.minCoverage;
  const sampleStepM = opts.sampleStepM ?? DEFAULT_MATCH_OPTS.sampleStepM;
  const bboxPadDeg = opts.bboxPadDeg ?? DEFAULT_MATCH_OPTS.bboxPadDeg;
  const endpointMaxM = opts.endpointMaxM ?? DEFAULT_MATCH_OPTS.endpointMaxM;
  const maxMeanSampleDistM = opts.maxMeanSampleDistM ?? DEFAULT_MATCH_OPTS.maxMeanSampleDistM;

  const climbLatLon = climbCoordsLonLat(climb);
  const track = decodePolyline(encodedPolyline);
  if (climbLatLon.length < 2 || track.length < 2) {
    return { matched: false, coverage: 0 };
  }

  const climbBox = bboxFromCoords(climbLatLon);
  const trackBox = bboxFromCoords(track);
  if (!bboxesOverlap(climbBox, trackBox, bboxPadDeg)) {
    return { matched: false, coverage: 0 };
  }

  const startDist = minDistToTrackM(
    climbLatLon[0][0],
    climbLatLon[0][1],
    track
  );
  const endPt = climbLatLon[climbLatLon.length - 1];
  const endDist = minDistToTrackM(endPt[0], endPt[1], track);
  if (startDist > endpointMaxM || endDist > endpointMaxM) {
    return { matched: false, coverage: 0, endpointMiss: true };
  }

  const cum = cumulativeDistancesM(climbLatLon);
  const totalLen = cum[cum.length - 1];
  if (totalLen < 50) return { matched: false, coverage: 0 };

  let hit = 0;
  let sampled = 0;
  let distSum = 0;
  for (let dist = 0; dist <= totalLen; dist += sampleStepM) {
    sampled += 1;
    let idx = 0;
    while (idx < cum.length - 1 && cum[idx + 1] < dist) idx += 1;
    const segLen = cum[idx + 1] - cum[idx] || 1;
    const t = (dist - cum[idx]) / segLen;
    const lat = climbLatLon[idx][0] + t * (climbLatLon[idx + 1][0] - climbLatLon[idx][0]);
    const lon = climbLatLon[idx][1] + t * (climbLatLon[idx + 1][1] - climbLatLon[idx][1]);
    const d = minDistToTrackM(lat, lon, track);
    distSum += d;
    if (d <= bufferM) hit += 1;
  }

  const coverage = sampled ? hit / sampled : 0;
  const meanDist = sampled ? distSum / sampled : Infinity;
  const matched =
    coverage >= minCoverage && meanDist <= maxMeanSampleDistM;
  return {
    matched,
    coverage: Math.round(coverage * 1000) / 1000,
    meanDistM: Math.round(meanDist),
  };
}

/** Buiten-fietsen voor klim-match; geen trainer/Zwift/FulGaz (VirtualRide). */
function isOutdoorCyclingActivity(activity) {
  if (!activity) return false;
  if (activity.trainer === true) return false;

  const sport = String(activity.sport_type || activity.type || "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (!sport) return false;
  if (sport === "virtualride" || sport.includes("indoor")) return false;

  const outdoor = new Set([
    "ride",
    "mountainbikeride",
    "gravelride",
    "ebikeride",
    "emountainbikeride",
    "cyclocross",
    "handcycle",
    "bikeride",
  ]);
  if (!outdoor.has(sport)) return false;

  const distM = Number(activity.distance);
  if (Number.isFinite(distM) && distM > 0 && distM < 800) {
    return false;
  }

  return true;
}

/** Buiten-fietsen voor klim-match; geen trainer/Zwift/FulGaz (VirtualRide). */
function isOutdoorCyclingActivity(activity) {
  if (!activity) return false;
  if (activity.trainer === true) return false;

  const sport = String(activity.sport_type || activity.type || "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (!sport) return false;
  if (sport === "virtualride" || sport.includes("indoor")) return false;

  const outdoor = new Set([
    "ride",
    "mountainbikeride",
    "gravelride",
    "ebikeride",
    "emountainbikeride",
    "cyclocross",
    "handcycle",
    "bikeride",
  ]);
  if (!outdoor.has(sport)) return false;

  const distM = Number(activity.distance);
  if (Number.isFinite(distM) && distM > 0 && distM < 800) {
    return false;
  }

  return true;
}

/** @deprecated alias — sync gebruikt alleen buitenritten */
function isCyclingActivity(activity) {
  return isOutdoorCyclingActivity(activity);
}

/** Climbs whose bbox overlaps the activity track bbox (cheap prefilter). */
function climbsNearEncodedPolyline(climbs, encodedPolyline, padDeg = DEFAULT_MATCH_OPTS.bboxPadDeg) {
  const track = decodePolyline(encodedPolyline);
  if (track.length < 2) return [];
  const trackBox = bboxFromCoords(track);
  const out = [];
  for (const climb of climbs) {
    const coords = climbCoordsLonLat(climb);
    if (coords.length < 2) continue;
    if (bboxesOverlap(bboxFromCoords(coords), trackBox, padDeg)) {
      out.push(climb);
    }
  }
  return out;
}

module.exports = {
  decodePolyline,
  matchClimbToActivity,
  isCyclingActivity,
  isOutdoorCyclingActivity,
  DEFAULT_MATCH_OPTS,
  bboxFromCoords,
  climbsNearEncodedPolyline,
};
