/**
 * Run: node fietsklimJournalSchema.test.js
 */
const assert = require("assert");
const { mergeClaimIntoJournal, recomputeJournalStats } = require("./fietsklimJournalSchema");

let entry = mergeClaimIntoJournal(null, {
  datasetId: "nl",
  climbId: "c1",
  climbName: "Berg",
  activityId: "a1",
  activityStartAt: Date.parse("2024-06-10T10:00:00Z"),
  source: "engine",
  coverage: 0.9,
});
assert.strictEqual(entry.ascent_count, 1);
assert.strictEqual(entry.first_claimed_at, Date.parse("2024-06-10T10:00:00Z"));

entry = mergeClaimIntoJournal(entry, {
  datasetId: "nl",
  climbId: "c1",
  activityId: "a2",
  activityStartAt: Date.parse("2020-01-01T10:00:00Z"),
  source: "engine",
  coverage: 0.85,
});
assert.strictEqual(entry.ascent_count, 2);
assert.strictEqual(entry.first_claimed_at, Date.parse("2020-01-01T10:00:00Z"));
assert.strictEqual(entry.last_ascent_at, Date.parse("2024-06-10T10:00:00Z"));

entry = mergeClaimIntoJournal(entry, {
  datasetId: "nl",
  climbId: "c1",
  activityId: "a2",
  activityStartAt: Date.parse("2020-01-01T10:00:00Z"),
  source: "user",
});
assert.strictEqual(entry.ascent_count, 2);
assert.strictEqual(entry.ascents.find((a) => a.activity_id === "a2").source, "user");

const stats = recomputeJournalStats(entry.ascents);
assert.strictEqual(stats.ascent_count, 2);

console.log("fietsklimJournalSchema.test.js OK");
