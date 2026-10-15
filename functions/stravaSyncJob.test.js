/**
 * Run: node stravaSyncJob.test.js
 */
const assert = require("assert");
const bg = require("./stravaBackgroundSync");

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

const now = 1_700_000_000_000;
assert.strictEqual(
  bg.isStaleRunningJob({ status: "running", updatedAt: { toMillis: () => now - bg.RUNNING_STALE_MS - 1 } }, now),
  true
);
assert.strictEqual(
  bg.isStaleRunningJob({ status: "running", updatedAt: { toMillis: () => now - 60_000 } }, now),
  false
);
assert.strictEqual(bg.isStaleRunningJob({ status: "queued", updatedAt: { toMillis: () => now } }, now), false);

const diag = bg.syncJobDiagnostics({
  status: "running",
  updatedAt: new Date(now - bg.RUNNING_STALE_MS - 5000).toISOString(),
});
assert.strictEqual(diag.staleRunning, true);
assert.ok(diag.hints.length >= 2);

console.log("stravaSyncJob.test.js OK");
