/**
 * Run: node routeSyncPolicy.test.js
 */
const assert = require("assert");
const { isAllDatasetsToken, preferCplRouteSyncConfig } = require("./routeSyncPolicy");

assert.strictEqual(isAllDatasetsToken("__all__"), true);
assert.strictEqual(isAllDatasetsToken("nl-utrecht"), false);
assert.strictEqual(typeof preferCplRouteSyncConfig(), "boolean");

console.log("routeSyncPolicy.test.js OK");
