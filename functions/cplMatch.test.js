/**
 * Run: node cplMatch.test.js
 */
const assert = require("assert");
const { cplActivityToMatchRecord, encodedPolylineFromCplData } = require("./cplMatch");
const { buildCplLogPatch } = require("./cplSync");

const rec = cplActivityToMatchRecord("i123", {
  title: "Test ride",
  type: "Ride",
  date: "2025-06-01",
  distance_km: 42,
  intervals_map: "abcPoly",
});
assert.strictEqual(rec.cplActivityId, "i123");
assert.strictEqual(rec.map.summary_polyline, "abcPoly");

assert.strictEqual(
  encodedPolylineFromCplData({ strava_map: "s", intervals_map: "i" }),
  "i"
);
assert.strictEqual(
  encodedPolylineFromCplData({ map: { summary_polyline: "nested" } }),
  "nested"
);

const hit = {
  activity: {
    id: "i99",
    cplActivityId: "i99",
    name: "Cols",
    start_date_local: "2025-01-15T10:00:00",
  },
  coverage: 0.91,
  climbName: "Testberg",
};
const { patch } = buildCplLogPatch("nl-utrecht", "climb-1", hit, {}, Date.now());
assert.strictEqual(patch.source, "cpl");
assert.strictEqual(patch.cplActivityId, "i99");
assert.strictEqual(patch.done, true);

console.log("cplMatch.test.js OK");
