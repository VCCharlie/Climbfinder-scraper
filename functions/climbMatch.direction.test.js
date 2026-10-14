/**
 * Richting-check: alleen beklimmen in database-volgorde (voet → top), niet afdaling.
 * Run: node climbMatch.direction.test.js
 */
const assert = require("assert");
const { matchClimbToActivity, decodePolyline } = require("./climbMatch");

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

/** ~1.2 km climb heading west (O→W), voet oost, top west */
const climb = {
  id: "test-climb",
  geometry: {
    type: "LineString",
    coordinates: [],
  },
};

const baseLat = 48.2;
const baseLon = -3.5;
const steps = 50;
for (let i = 0; i <= steps; i++) {
  const t = i / steps;
  climb.geometry.coordinates.push([baseLon - t * 0.012, baseLat + t * 0.001]);
}

function trackForward() {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push([baseLat + t * 0.001, baseLon - t * 0.012]);
  }
  return encodePolyline(pts);
}

function trackReverse() {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push([baseLat + (1 - t) * 0.001, baseLon - (1 - t) * 0.012]);
  }
  return encodePolyline(pts);
}

const forward = matchClimbToActivity(climb, trackForward());
const reverse = matchClimbToActivity(climb, trackReverse());

assert.strictEqual(forward.matched, true, "beklimming in klimrichting moet matchen");
assert.strictEqual(reverse.matched, false, "afdaling (omgekeerde richting) mag niet matchen");
if (reverse.wrongDirection !== undefined) {
  assert.strictEqual(reverse.wrongDirection, true, "afdaling moet wrongDirection markeren");
}

console.log("climbMatch direction tests OK", {
  forwardCoverage: forward.coverage,
  reverseForwardAlongM: reverse.forwardAlongM,
});
