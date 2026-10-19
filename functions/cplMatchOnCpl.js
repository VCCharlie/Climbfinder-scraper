/**
 * Compute climb matches and persist on CPL activity docs (source of truth).
 * FietsKlim logbook import reads fietsklim_match from CPL.
 */
const { getCplFirestore } = require("./cplClient");
const { polylineFingerprint } = require("./activityMatchFingerprint");
const {
  encodedPolylineFromCplData,
  cplActivityToMatchRecord,
} = require("./cplMatch");
const { matchStoredActivitiesToClimbs, DETECTION_MATCH_OPTS } = require("./syncPipeline");
const {
  buildFietsklimMatchPayload,
  fietsklimMatchFromActivityData,
  needsRecompute,
} = require("./fietsklimMatchSchema");
const { activityLikelyInDataset, loadRegionDatasetRouter } = require("./regionDatasetRouter");
const { buildClimbSpatialIndex } = require("./climbSpatialIndex");

async function loadClimbIndexRevision(fetchDataJson) {
  const index = await fetchDataJson("index.json");
  const updated = index?.meta?.updated_at || index?.updated_at || "";
  const count = index?.total_climbs ?? index?.region_count ?? "";
  return `${updated}|${count}`;
}

/**
 * @param {string} docId
 * @param {object} rawData — CPL activity Firestore row
 * @param {string[]} regionIds
 * @param {{ routeMapPolicy?: string, force?: boolean, fetchDataJson: Function, loadDataset: Function }} opts
 */
async function ensureFietsklimMatchOnCplActivity(docId, rawData, regionIds, opts) {
  const routeMapPolicy = opts.routeMapPolicy === "intervals_only" ? "intervals_only" : "default";
  const matchAct = cplActivityToMatchRecord(docId, rawData, routeMapPolicy);
  const poly = encodedPolylineFromCplData(rawData, routeMapPolicy);
  if (!poly || !matchAct.map?.summary_polyline) {
    return { skipped: "no_polyline", hits: [], matchAct };
  }

  const polyline_fp = polylineFingerprint(poly);
  const indexRevision = await loadClimbIndexRevision(opts.fetchDataJson);
  const existing = fietsklimMatchFromActivityData(rawData);

  if (
    !needsRecompute(existing, {
      polylineFingerprint: polyline_fp,
      indexRevision,
      routeMapPolicy,
      force: Boolean(opts.force),
    })
  ) {
    return { skipped: "cached_on_cpl", hits: existing.hits, matchAct, block: existing };
  }

  const router = regionIds.length > 1
    ? await loadRegionDatasetRouter(opts.fetchDataJson)
    : null;

  const datasetCache = opts.datasetCache || new Map();
  const allHits = [];

  for (const datasetId of regionIds) {
    if (router && !activityLikelyInDataset(router, datasetId, poly)) {
      continue;
    }
    let bundle = datasetCache.get(datasetId);
    if (!bundle) {
      bundle = await opts.loadDataset(datasetId);
      bundle.spatialIndex = bundle.spatialIndex || buildClimbSpatialIndex(bundle.climbs || []);
      datasetCache.set(datasetId, bundle);
    }
    const { climbs, spatialIndex } = bundle;
    if (!climbs?.length) continue;

    const { bestByClimb } = matchStoredActivitiesToClimbs({
      climbs,
      spatialIndex,
      activities: [matchAct],
      includePrivate: true,
      matchOpts: DETECTION_MATCH_OPTS,
    });

    for (const [climbId, hit] of bestByClimb.entries()) {
      allHits.push({
        datasetId,
        climbId,
        climbName: hit.climbName || climbId,
        coverage: hit.coverage,
      });
    }
  }

  const payload = buildFietsklimMatchPayload({
    polylineFingerprint: polyline_fp,
    indexRevision,
    routeMapPolicy,
    hits: allHits,
  });

  if (opts.persist !== false) {
    await getCplFirestore()
      .collection("activities")
      .doc(String(docId))
      .set({ fietsklim_match: payload }, { merge: true });
  }

  return { skipped: null, hits: allHits, matchAct, block: payload };
}

/**
 * Merge hits into per-dataset bestByClimb maps for logbook write.
 * @param {Map<string, Map<string, object>>} acc
 */
function mergeHitsIntoBestByDataset(acc, hits, matchAct) {
  for (const h of hits || []) {
    let byClimb = acc.get(h.datasetId);
    if (!byClimb) {
      byClimb = new Map();
      acc.set(h.datasetId, byClimb);
    }
    const prev = byClimb.get(h.climbId);
    const hit = {
      activity: matchAct,
      coverage: h.coverage,
      climbName: h.climbName,
    };
    if (!prev || hit.coverage > prev.coverage) {
      byClimb.set(h.climbId, hit);
    }
  }
}

/**
 * Import fietsklim_match hits already on CPL docs (no recompute).
 */
function hitsFromStoredCplMatch(rawData, matchAct) {
  const block = fietsklimMatchFromActivityData(rawData);
  if (!block?.hits?.length) return [];
  return block.hits.map((h) => ({ ...h, matchAct }));
}

function mergeStoredActivityMatchesIntoBest(acc, rawData, matchAct) {
  const hits = hitsFromStoredCplMatch(rawData, matchAct);
  mergeHitsIntoBestByDataset(acc, hits, matchAct);
}

module.exports = {
  loadClimbIndexRevision,
  ensureFietsklimMatchOnCplActivity,
  mergeHitsIntoBestByDataset,
  mergeStoredActivityMatchesIntoBest,
  hitsFromStoredCplMatch,
};
