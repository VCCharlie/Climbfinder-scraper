/**
 * Geaggregeerd FietsKlim-logboek per klim op CPL (users/{ownerId}/fietsklim_journal/{id}).
 */
const JOURNAL_SCHEMA_VERSION = 1;
const MAX_ASCENTS_STORED = 250;

function journalDocId(datasetId, climbId) {
  return `${datasetId}__${climbId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 450);
}

function normalizeAscent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const activityId = String(raw.activity_id || raw.activityId || "").trim();
  if (!activityId) return null;
  const startAt = Number(raw.activity_start_at ?? raw.activityStartAt);
  const coverage = Number(raw.coverage);
  const source = raw.source === "user" ? "user" : "engine";
  return {
    activity_id: activityId,
    activity_start_at: Number.isFinite(startAt) ? startAt : null,
    activity_name: raw.activity_name != null ? String(raw.activity_name) : raw.activityName != null ? String(raw.activityName) : null,
    strava_id: raw.strava_id != null ? raw.strava_id : raw.stravaId != null ? raw.stravaId : null,
    coverage: Number.isFinite(coverage) ? coverage : null,
    source,
  };
}

function normalizeJournalEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const datasetId = String(raw.datasetId || "").trim();
  const climbId = String(raw.climbId || "").trim();
  if (!datasetId || !climbId) return null;
  const ascents = Array.isArray(raw.ascents) ? raw.ascents.map(normalizeAscent).filter(Boolean) : [];
  const first = Number(raw.first_claimed_at ?? raw.firstClaimedAt);
  const last = Number(raw.last_ascent_at ?? raw.lastAscentAt);
  const count = Number(raw.ascent_count ?? raw.ascentCount);
  return {
    schema_version: Number(raw.schema_version) || JOURNAL_SCHEMA_VERSION,
    datasetId,
    climbId,
    climbName: raw.climbName != null ? String(raw.climbName) : null,
    ascent_count: Number.isFinite(count) ? count : ascents.length,
    first_claimed_at: Number.isFinite(first) ? first : null,
    last_ascent_at: Number.isFinite(last) ? last : null,
    ascents,
    updated_at: raw.updated_at || raw.updatedAt || null,
  };
}

function recomputeJournalStats(ascents) {
  let first = null;
  let last = null;
  for (const a of ascents) {
    const t = a.activity_start_at;
    if (t == null || !Number.isFinite(t)) continue;
    if (first == null || t < first) first = t;
    if (last == null || t > last) last = t;
  }
  return {
    ascent_count: ascents.length,
    first_claimed_at: first,
    last_ascent_at: last,
  };
}

/**
 * Merge één rit-claim in bestaande journal-entry (in-memory).
 * @param {object|null} existing
 * @param {{ datasetId, climbId, climbName?, activityId, activityStartAt?, activityName?, stravaId?, coverage?, source? }} claim
 */
function mergeClaimIntoJournal(existing, claim) {
  const datasetId = String(claim.datasetId);
  const climbId = String(claim.climbId);
  const base =
    existing && existing.datasetId === datasetId && existing.climbId === climbId
      ? { ...existing, ascents: [...(existing.ascents || [])] }
      : {
          schema_version: JOURNAL_SCHEMA_VERSION,
          datasetId,
          climbId,
          climbName: claim.climbName || null,
          ascent_count: 0,
          first_claimed_at: null,
          last_ascent_at: null,
          ascents: [],
        };

  if (claim.climbName && !base.climbName) base.climbName = claim.climbName;

  const activityId = String(claim.activityId);
  const idx = base.ascents.findIndex((a) => a.activity_id === activityId);
  const nextAscent = normalizeAscent({
    activity_id: activityId,
    activity_start_at: claim.activityStartAt,
    activity_name: claim.activityName,
    strava_id: claim.stravaId,
    coverage: claim.coverage,
    source: claim.source === "user" ? "user" : "engine",
  });

  if (idx >= 0) {
    const prev = base.ascents[idx];
    base.ascents[idx] = {
      ...prev,
      ...nextAscent,
      source: prev.source === "user" || nextAscent.source === "user" ? "user" : "engine",
      coverage:
        nextAscent.coverage != null &&
        (prev.coverage == null || nextAscent.coverage > prev.coverage)
          ? nextAscent.coverage
          : prev.coverage,
    };
  } else {
    base.ascents.push(nextAscent);
  }

  if (base.ascents.length > MAX_ASCENTS_STORED) {
    base.ascents.sort((a, b) => (b.activity_start_at || 0) - (a.activity_start_at || 0));
    base.ascents = base.ascents.slice(0, MAX_ASCENTS_STORED);
  }

  const stats = recomputeJournalStats(base.ascents);
  base.ascent_count = stats.ascent_count;
  base.first_claimed_at = stats.first_claimed_at;
  base.last_ascent_at = stats.last_ascent_at;
  base.updated_at = new Date().toISOString();
  return base;
}

function latestAscent(entry) {
  if (!entry?.ascents?.length) return null;
  let best = entry.ascents[0];
  for (const a of entry.ascents) {
    const t = a.activity_start_at || 0;
    const bt = best.activity_start_at || 0;
    if (t >= bt) best = a;
  }
  return best;
}

function journalEntryToAuthoritativeId(entry) {
  if (!entry) return null;
  return journalDocId(entry.datasetId, entry.climbId);
}

module.exports = {
  JOURNAL_SCHEMA_VERSION,
  MAX_ASCENTS_STORED,
  journalDocId,
  normalizeAscent,
  normalizeJournalEntry,
  recomputeJournalStats,
  mergeClaimIntoJournal,
  latestAscent,
  journalEntryToAuthoritativeId,
};
