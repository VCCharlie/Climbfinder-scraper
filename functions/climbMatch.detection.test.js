/**
 * Detection-biased opts must still reject parallel road ~40 m offset.
 * Run: node climbMatch.detection.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  matchClimbToActivity,
  climbCoordsLonLat,
  DETECTION_MATCH_OPTS,
} = require("./climbMatch");

function encodePolyline(coords) {
  let lastLat = 0;
  let lastLon = 0;
  let result = "";
  for (const [lat, lon] of coords) {
    const latE5 = Math.round(lat * 1e5);
    const lonE5 = Math.round(lon * 1e5);
    result += encodeSigned(latE5 - lastLat);
    result += encodeSigned(lonE5 - lastLon);
    lastLat = latE5;
    lastLon = lonE5;
  }
  return result;
}

function encodeSigned(num) {
  let sgn = num << 1;
  if (num < 0) sgn = ~sgn;
  let out = "";
  while (sgn >= 0x20) {
    out += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63);
    sgn >>= 5;
  }
  out += String.fromCharCode(sgn + 63);
  return out;
}

function lateralOffsetTrack(climb, offsetM) {
  const latLon = climbCoordsLonLat(climb);
  const latOff = offsetM / 111320;
  const lonOff = offsetM / (111320 * Math.cos((latLon[0][0] * Math.PI) / 180));
  const shifted = latLon.map(([lat, lon]) => [lat + latOff, lon + lonOff * 0.35]);
  return encodePolyline(shifted);
}

const datasetPath = path.join(__dirname, "../docs/climbs/data/cf-l63-la-maurienne.json");
const raw = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
const karellis = raw.climbs.find((c) => c.id === "les-karellis-saint-le-bochet");
assert.ok(karellis, "Les Karellis climb in dataset");

const onRoad = lateralOffsetTrack(karellis, 8);
const parallelValley = lateralOffsetTrack(karellis, 42);

const hitRoad = matchClimbToActivity(karellis, onRoad, DETECTION_MATCH_OPTS);
const hitParallel = matchClimbToActivity(karellis, parallelValley, DETECTION_MATCH_OPTS);

assert.strictEqual(hitRoad.matched, true);
assert.strictEqual(hitParallel.matched, false);

console.log("climbMatch.detection.test.js OK");
