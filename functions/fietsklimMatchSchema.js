/**
 * Contract: climb matches stored on CPL Firestore activity documents.
 * CPL app (or FietsKlim worker) writes; FietsKlim logbook import reads.
 */
const MATCH_SCHEMA_VERSION = 1;
const MATCHER_VERSION = "2026.10.1";

function normalizeHit(raw) {
  if (!raw || typeof raw !== "object") return null;
  const datasetId = String(raw.datasetId || "").trim();
  const climbId = String(raw.climbId || "").trim();
  if (!datasetId || !climbId) return null;
  const coverage = Number(raw.coverage);
  return {
    datasetId,
    climbId,
    climbName: raw.climbName != null ? String(raw.climbName) : null,
    coverage: Number.isFinite(coverage) ? coverage : 0,
  };
}

function normalizeFietsklimMatchBlock(raw) {
  if (!raw || typeof raw !== "object") return null;
  const hits = Array.isArray(raw.hits) ? raw.hits.map(normalizeHit).filter(Boolean) : [];
  return {
    schema_version: Number(raw.schema_version) || MATCH_SCHEMA_VERSION,
    matcher_version: String(raw.matcher_version || ""),
    polyline_fingerprint: String(raw.polyline_fingerprint || ""),
    climb_index_revision: String(raw.climb_index_revision || ""),
    route_map_policy: raw.route_map_policy === "intervals_only" ? "intervals_only" : "default",
    computed_at: raw.computed_at || null,
    hits,
  };
}

function fietsklimMatchFromActivityData(data) {
  return normalizeFietsklimMatchBlock(data?.fietsklim_match);
}

function needsRecompute(existing, { polylineFingerprint, indexRevision, routeMapPolicy, force }) {
  if (force) return true;
  if (!existing || !existing.computed_at) return true;
  if (existing.schema_version !== MATCH_SCHEMA_VERSION) return true;
  if (existing.polyline_fingerprint !== polylineFingerprint) return true;
  if (existing.climb_index_revision !== indexRevision) return true;
  if (existing.route_map_policy !== routeMapPolicy) return true;
  return false;
}

function buildFietsklimMatchPayload({
  polylineFingerprint,
  indexRevision,
  routeMapPolicy,
  hits,
}) {
  return {
    schema_version: MATCH_SCHEMA_VERSION,
    matcher_version: MATCHER_VERSION,
    polyline_fingerprint: polylineFingerprint,
    climb_index_revision: indexRevision,
    route_map_policy: routeMapPolicy === "intervals_only" ? "intervals_only" : "default",
    computed_at: new Date().toISOString(),
    hits: (hits || []).map((h) => ({
      datasetId: h.datasetId,
      climbId: h.climbId,
      climbName: h.climbName || null,
      coverage: h.coverage,
    })),
  };
}

module.exports = {
  MATCH_SCHEMA_VERSION,
  MATCHER_VERSION,
  normalizeHit,
  normalizeFietsklimMatchBlock,
  fietsklimMatchFromActivityData,
  needsRecompute,
  buildFietsklimMatchPayload,
};
