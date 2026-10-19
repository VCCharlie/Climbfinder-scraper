/**
 * Run: node cplActivityList.test.js
 */
const assert = require("assert");
const { summarizeCplActivityForList } = require("./cplSync");

const row = summarizeCplActivityForList("act1", {
  title: "Cols",
  date: "2024-01-02",
  ownerId: "u1",
  fietsklim_match: {
    schema_version: 1,
    computed_at: "2024-01-01T00:00:00Z",
    hits: [{ datasetId: "nl", climbId: "c1", coverage: 0.9 }],
  },
  fietsklim_user_links: [{ datasetId: "nl", climbId: "c2", climbName: "X" }],
  intervals_map: "poly",
});
assert.strictEqual(row.id, "act1");
assert.strictEqual(row.engineHitCount, 1);
assert.strictEqual(row.userLinkCount, 1);
assert.strictEqual(row.hasRoute, true);

console.log("cplActivityList.test.js OK");
