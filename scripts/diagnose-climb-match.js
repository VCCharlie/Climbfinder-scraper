#!/usr/bin/env node
/**
 * Diagnose polyline ↔ klim-match voor één rit (bv. Intervals i6216774).
 *
 *   node scripts/diagnose-climb-match.js \
 *     --dataset docs/climbs/data/cf-l63-la-maurienne.json \
 *     --climb les-karellis-saint-le-bochet \
 *     --polyline-file /path/to/encoded-polyline.txt
 *
 * Polyline: Google-encoded summary (zelfde als CPL strava_map / intervals_map).
 * Export: Intervals activity → download GPX/FIT of kopieer map uit CPL Firestore.
 */
const fs = require("fs");
const path = require("path");
const { matchClimbToActivity, climbsNearEncodedPolyline } = require("../functions/climbMatch");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const datasetPath = arg("--dataset");
const climbId = arg("--climb");
const polyFile = arg("--polyline-file");
const polyInline = arg("--polyline");

if (!datasetPath || !climbId || (!polyFile && !polyInline)) {
  console.error(
    "Usage: node scripts/diagnose-climb-match.js --dataset <json> --climb <id> --polyline-file <file>"
  );
  process.exit(1);
}

const poly = polyInline || fs.readFileSync(polyFile, "utf8").trim();
const raw = JSON.parse(fs.readFileSync(path.resolve(datasetPath), "utf8"));
const climbs = raw.climbs || [];
const climb = climbs.find((c) => c.id === climbId);
if (!climb) {
  console.error("Climb not found:", climbId);
  process.exit(1);
}

const result = matchClimbToActivity(climb, poly);
console.log("Target climb:", climb.name, climbId);
console.log("Match:", result);

const near = climbsNearEncodedPolyline(climbs, poly);
const hits = [];
for (const c of near) {
  const r = matchClimbToActivity(c, poly);
  if (r.matched) {
    hits.push({
      id: c.id,
      name: c.name,
      coverage: r.coverage,
      meanDistM: r.meanDistM,
      p90DistM: r.p90DistM,
    });
  }
}
hits.sort((a, b) => b.coverage - a.coverage);
console.log("\nMatched climbs in dataset:", hits.length);
console.log(hits.slice(0, 25));
