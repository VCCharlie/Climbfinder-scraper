/**
 * Run: node stravaSyncJob.test.js
 */
const assert = require("assert");

function progressFromSummary(summary) {
  if (!summary) return {};
  return {
    activitiesScanned: summary.activitiesScanned ?? 0,
    uniqueClimbs: summary.uniqueClimbs ?? summary.matchesWritten ?? 0,
    nextPage: summary.nextPage ?? null,
    regionIndex: summary.nextDatasetIndex ?? 0,
    completed: Boolean(summary.completed),
  };
}

assert.deepStrictEqual(
  progressFromSummary({ activitiesScanned: 12, matchesWritten: 3, nextPage: 4, completed: false }),
  {
    activitiesScanned: 12,
    uniqueClimbs: 3,
    nextPage: 4,
    regionIndex: 0,
    completed: false,
  }
);

assert.strictEqual(progressFromSummary({ completed: true }).completed, true);

console.log("stravaSyncJob.test.js OK");
