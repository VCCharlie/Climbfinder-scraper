/**
 * Rit zuidwaarts vanuit St-Michel mag Les Karellis (noordelijker) nooit matchen.
 * Run: node climbMatch.geography.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { matchClimbToActivity } = require("./climbMatch");

function encodePolyline(coords) {
  let lastLat = 0;
  let lastLon = 0;
  let result = "";
  for (const [lat, lon] of coords) {
    const latE5 = Math.round(lat * 1e5);
    const lonE5 = Math.round(lon * 1e5);
    result += encodeSigned(latE5 - lastLat);
    result += encodeSigned(lonE5 - lastLon);
    lastLat = latE5;
    lastLon = lonE5;
  }
  return result;
}

function encodeSigned(num) {
  let sgn = num << 1;
  if (num < 0) sgn = ~sgn;
  let out = "";
  while (sgn >= 0x20) {
    out += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63);
    sgn >>= 5;
  }
  out += String.fromCharCode(sgn + 63);
  return out;
}

/** St-Michel-de-Maurienne (~45.217, 6.274) richting zuid — geen noordelijke tak. */
function southFromStMichelPolyline() {
  const pts = [];
  let lat = 45.217;
  let lon = 6.274;
  for (let i = 0; i <= 50; i++) {
    pts.push([lat, lon]);
    lat -= 0.0012;
    lon += 0.0004;
  }
  return encodePolyline(pts);
}

const datasetPath = path.join(__dirname, "../docs/climbs/data/cf-l63-la-maurienne.json");
const raw = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
const karellis = raw.climbs.find((c) => c.id === "les-karellis-saint-le-bochet");
assert.ok(karellis);

const southRide = southFromStMichelPolyline();
const result = matchClimbToActivity(karellis, southRide);

assert.strictEqual(
  result.matched,
  false,
  "Karellis (noordelijker dan St-Michel) mag niet matchen op zuidwaartse rit"
);
assert.strictEqual(result.outsideRiddenCorridor, true);

console.log("climbMatch.geography.test.js OK", result);
