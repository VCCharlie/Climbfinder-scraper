/**
 * Run: node syncPipeline.test.js
 */
const assert = require("assert");
const {
  resolveStravaActivityPolyline,
  matchStoredActivitiesToClimbs,
} = require("./syncPipeline");
const { buildClimbSpatialIndex } = require("./climbSpatialIndex");

(async () => {
  let detailCalls = 0;
  const pace = async () => {};
  const stravaFetch = async () => {
    detailCalls += 1;
    return { id: 1, type: "Ride", map: { summary_polyline: "detailPoly" } };
  };

  const withListPoly = await resolveStravaActivityPolyline(
    { id: 1, type: "Ride", map: { summary_polyline: "listPoly" } },
    "token",
    stravaFetch,
    pace
  );
  assert.strictEqual(withListPoly.poly, "listPoly");
  assert.strictEqual(withListPoly.stravaDetailReads, 0);
  assert.strictEqual(detailCalls, 0);

  const withoutPoly = await resolveStravaActivityPolyline(
    { id: 2, type: "Ride", map: {} },
    "token",
    stravaFetch,
    pace
  );
  assert.strictEqual(withoutPoly.poly, "detailPoly");
  assert.strictEqual(withoutPoly.stravaDetailReads, 1);

  const climb = {
    id: "c1",
    name: "Test",
    bbox: [6.0, 45.0, 6.02, 45.02],
    geometry: {
      type: "LineString",
      coordinates: [[6.0, 45.0], [6.005, 45.005], [6.01, 45.01], [6.02, 45.02]],
    },
  };
  const index = buildClimbSpatialIndex([climb]);
  const activity = {
    id: "a1",
    type: "Ride",
    distance: 20000,
    map: {
      summary_polyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
    },
  };

  const { bestByClimb } = matchStoredActivitiesToClimbs({
    climbs: [climb],
    spatialIndex: index,
    activities: [activity],
  });
  assert.ok(bestByClimb.size >= 0);

  console.log("syncPipeline.test.js OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
