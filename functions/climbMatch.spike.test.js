/**
 * GPS-spike in Strava-polyline mag geen match op klim 7+ km verderop geven.
 * Run: node climbMatch.spike.test.js
 */
const assert = require("assert");
const { matchClimbToActivity } = require("./climbMatch");

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

/** Amersfoortse Berg (eerste punten uit cf-l275-utrecht) */
const climb = {
  id: "amersfoort-test",
  geometry: {
    type: "LineString",
    coordinates: [
      [5.36084, 52.15215],
      [5.36108, 52.15198],
      [5.36132, 52.15181],
      [5.36157, 52.15164],
      [5.36181, 52.15147],
      [5.36205, 52.15131],
      [5.36227, 52.15112],
      [5.36245, 52.15093],
    ],
  },
};

/** Rit in Soesterberg + kunstmatige spike naar Amersfoort (zoals slechte summary_polyline). */
function trackWithSpikeToClimb() {
  const pts = [];
  for (let i = 0; i <= 20; i++) {
    pts.push([52.127 + i * 0.0002, 5.286 + i * 0.0001]);
  }
  pts.push([52.15215, 5.36084]);
  for (let i = 20; i >= 0; i--) {
    pts.push([52.127 + i * 0.0002, 5.286 + i * 0.0001]);
  }
  return encodePolyline(pts);
}

const spikeMatch = matchClimbToActivity(climb, trackWithSpikeToClimb());
assert.strictEqual(
  spikeMatch.matched,
  false,
  "klim mag niet matchen via GPS-spike chord over ~7 km"
);

console.log("climbMatch spike tests OK", { coverage: spikeMatch.coverage });
