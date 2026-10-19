/**
 * Run: node cplMatchOnCpl.test.js
 */
const assert = require("assert");
const { mergeHitsIntoBestByDataset, mergeStoredActivityMatchesIntoBest } = require("./cplMatchOnCpl");

const matchAct = { id: "a1", cplActivityId: "a1", name: "Ride" };
const acc = new Map();
mergeHitsIntoBestByDataset(acc, [
  { datasetId: "nl", climbId: "c1", climbName: "A", coverage: 0.5 },
  { datasetId: "nl", climbId: "c1", climbName: "A", coverage: 0.9 },
], matchAct);
const byClimb = acc.get("nl");
assert.strictEqual(byClimb.size, 1);
assert.strictEqual(byClimb.get("c1").coverage, 0.9);

const raw = {
  fietsklim_match: {
    schema_version: 1,
    matcher_version: "t",
    polyline_fingerprint: "x",
    climb_index_revision: "y",
    route_map_policy: "default",
    computed_at: "2026-01-01T00:00:00.000Z",
    hits: [{ datasetId: "be", climbId: "c2", climbName: "B", coverage: 0.7 }],
  },
};
const acc2 = new Map();
mergeStoredActivityMatchesIntoBest(acc2, raw, matchAct);
assert.strictEqual(acc2.get("be").get("c2").coverage, 0.7);

console.log("cplMatchOnCpl.test.js OK");
