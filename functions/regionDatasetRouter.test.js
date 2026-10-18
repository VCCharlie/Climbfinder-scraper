/**
 * Run: node regionDatasetRouter.test.js
 */
const assert = require("assert");
const {
  buildRegionDatasetRouter,
  activityLikelyInDataset,
} = require("./regionDatasetRouter");

const router = buildRegionDatasetRouter(
  {
    regions: [
      { id: "cf-l-be", locality_id: 304, country: "BE" },
      { id: "cf-l-fr", locality_id: 9999, country: "FR" },
    ],
  },
  {
    regions: {
      304: { lat: 50.5, lon: 5.8 },
      9999: { lat: 45.0, lon: 6.0 },
    },
  }
);

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

const nearBe = encodePolyline([[50.51, 5.81], [50.52, 5.82]]);
const nearFr = encodePolyline([[45.01, 6.01], [45.02, 6.02]]);

assert.strictEqual(activityLikelyInDataset(router, "cf-l-be", nearBe), true);
assert.strictEqual(activityLikelyInDataset(router, "cf-l-fr", nearBe), false);
assert.strictEqual(activityLikelyInDataset(router, "cf-l-fr", nearFr), true);

console.log("regionDatasetRouter.test.js OK");
