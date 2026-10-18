/**
 * Run: node climbSpatialIndex.test.js
 */
const assert = require("assert");
const { buildClimbSpatialIndex, queryClimbsInTrackBox } = require("./climbSpatialIndex");
const { bboxFromCoords } = require("./climbMatch");

const climbs = [
  {
    id: "a",
    bbox: [6.0, 45.0, 6.01, 45.01],
    geometry: { type: "LineString", coordinates: [[6.0, 45.0], [6.01, 45.01]] },
  },
  {
    id: "b",
    bbox: [8.0, 46.0, 8.01, 46.01],
    geometry: { type: "LineString", coordinates: [[8.0, 46.0], [8.01, 46.01]] },
  },
];

const index = buildClimbSpatialIndex(climbs);
const nearBox = bboxFromCoords([[45.005, 6.005], [45.006, 6.006]]);
const farBox = bboxFromCoords([[46.005, 8.005], [46.006, 8.006]]);

const near = queryClimbsInTrackBox(index, nearBox, 200);
const far = queryClimbsInTrackBox(index, farBox, 200);

assert.strictEqual(near.length, 1);
assert.strictEqual(near[0].id, "a");
assert.strictEqual(far.length, 1);
assert.strictEqual(far[0].id, "b");

console.log("climbSpatialIndex.test.js OK");
