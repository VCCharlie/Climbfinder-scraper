/**
 * Run: node fietsklimMatchSchema.test.js
 */
const assert = require("assert");
const {
  needsRecompute,
  buildFietsklimMatchPayload,
  normalizeFietsklimMatchBlock,
  MATCH_SCHEMA_VERSION,
} = require("./fietsklimMatchSchema");

const payload = buildFietsklimMatchPayload({
  polylineFingerprint: "fp1",
  indexRevision: "rev1",
  routeMapPolicy: "default",
  hits: [{ datasetId: "nl", climbId: "c1", climbName: "Berg", coverage: 0.8 }],
});
assert.strictEqual(payload.schema_version, MATCH_SCHEMA_VERSION);
assert.strictEqual(payload.hits.length, 1);

const existing = normalizeFietsklimMatchBlock(payload);
assert.strictEqual(
  needsRecompute(existing, {
    polylineFingerprint: "fp1",
    indexRevision: "rev1",
    routeMapPolicy: "default",
    force: false,
  }),
  false
);

const emptyHits = normalizeFietsklimMatchBlock({
  ...payload,
  hits: [],
});
assert.strictEqual(
  needsRecompute(emptyHits, {
    polylineFingerprint: "fp1",
    indexRevision: "rev1",
    routeMapPolicy: "default",
    force: false,
  }),
  false
);

assert.strictEqual(
  needsRecompute(existing, {
    polylineFingerprint: "fp2",
    indexRevision: "rev1",
    routeMapPolicy: "default",
    force: false,
  }),
  true
);

console.log("fietsklimMatchSchema.test.js OK");
