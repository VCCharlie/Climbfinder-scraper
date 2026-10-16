/**
 * Run: node cplDateQuery.test.js
 */
const assert = require("assert");

function ymdFromMsLocal(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ymdDayAfterLocal(ms) {
  const d = new Date(ms);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return ymdFromMsLocal(d.getTime());
}

const june4End = new Date("2022-06-04T23:59:59").getTime();
const endExclusive = ymdDayAfterLocal(june4End);
assert.strictEqual(endExclusive, "2022-06-05");

const iso = "2022-06-04T14:30:00";
assert.ok(iso >= "2022-06-04" && iso < endExclusive);
assert.ok(!(iso <= "2022-06-04"));

console.log("cplDateQuery.test.js OK");
