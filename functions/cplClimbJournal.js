/**
 * CPL fietsklim_journal: aggregate claims + import naar FietsKlim climbLog.
 */
const { getCplFirestore } = require("./cplClient");
const { fietsklimMatchFromActivityData } = require("./fietsklimMatchSchema");
const { userLinksFromActivityData } = require("./fietsklimUserLinksSchema");
const {
  journalDocId,
  normalizeJournalEntry,
  mergeClaimIntoJournal,
  latestAscent,
} = require("./fietsklimJournalSchema");

function activityStartFromMatchAct(matchAct, rawData) {
  const raw = matchAct?.start_date_local || matchAct?.start_date;
  if (raw) {
    const t = Date.parse(String(raw));
    if (Number.isFinite(t)) return t;
  }
  const d = rawData?.date ?? rawData?.start_date_local ?? rawData?.start_date;
  if (d == null) return null;
  if (typeof d.toDate === "function") {
    try {
      return d.toDate().getTime();
    } catch {
      /* ignore */
    }
  }
  const s = String(d).trim();
  const t = Date.parse(s.includes("T") ? s : `${s.slice(0, 10)}T12:00:00`);
  return Number.isFinite(t) ? t : null;
}

/**
 * Alle claims op één CPL-activiteit (engine + user).
 */
function claimsFromActivity(docId, rawData, matchAct) {
  const activityId = String(docId);
  const activityStartAt = activityStartFromMatchAct(matchAct, rawData);
  const activityName = matchAct?.name || rawData?.title || rawData?.name || null;
  const stravaId = matchAct?.strava_id ?? rawData?.strava_id ?? null;
  const claims = [];

  const block = fietsklimMatchFromActivityData(rawData);
  for (const h of block?.hits || []) {
    claims.push({
      datasetId: h.datasetId,
      climbId: h.climbId,
      climbName: h.climbName,
      coverage: h.coverage,
      source: "engine",
      activityId,
      activityStartAt,
      activityName,
      stravaId,
    });
  }

  for (const u of userLinksFromActivityData(rawData)) {
    claims.push({
      datasetId: u.datasetId,
      climbId: u.climbId,
      climbName: u.climbName,
      coverage: null,
      source: "user",
      activityId,
      activityStartAt,
      activityName,
      stravaId,
    });
  }

  return claims;
}

function journalCollection(cplOwnerId) {
  return getCplFirestore().collection("users").doc(String(cplOwnerId)).collection("fietsklim_journal");
}

/**
 * @param {string} cplOwnerId
 * @param {{ id: string, data: object, matchAct: object }[]} activityRows
 * @param {{ persist?: boolean, regionIds?: string[] }} opts
 * @returns {Promise<{ entries: object[], touchedKeys: string[] }>}
 */
async function applyActivitiesToCplJournal(cplOwnerId, activityRows, opts = {}) {
  const regionSet = opts.regionIds?.length ? new Set(opts.regionIds) : null;
  const byKey = new Map();

  for (const row of activityRows || []) {
    const claims = claimsFromActivity(row.id, row.data, row.matchAct);
    for (const claim of claims) {
      if (regionSet && !regionSet.has(claim.datasetId)) continue;
      const key = journalDocId(claim.datasetId, claim.climbId);
      const prev = byKey.get(key);
      byKey.set(key, mergeClaimIntoJournal(prev, claim));
    }
  }

  const entries = [...byKey.values()];
  const touchedKeys = [...byKey.keys()];
  if (opts.persist === false || !entries.length) {
    return { entries, touchedKeys };
  }

  const col = journalCollection(cplOwnerId);
  const CHUNK = 400;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK);
    const batch = getCplFirestore().batch();
    for (const entry of slice) {
      const id = journalDocId(entry.datasetId, entry.climbId);
      batch.set(col.doc(id), entry, { merge: true });
    }
    await batch.commit();
  }

  return { entries, touchedKeys };
}

async function fetchJournalEntries(cplOwnerId, keys) {
  if (!keys?.length) return [];
  const col = journalCollection(cplOwnerId);
  const refs = keys.map((k) => col.doc(k));
  const snaps = await getCplFirestore().getAll(...refs);
  return snaps.filter((s) => s.exists).map((s) => normalizeJournalEntry(s.data()));
}

async function fetchAllJournalEntries(cplOwnerId) {
  const snap = await journalCollection(cplOwnerId).get();
  const out = [];
  for (const doc of snap.docs) {
    const e = normalizeJournalEntry(doc.data());
    if (e) out.push(e);
  }
  return out;
}

/**
 * Voeg handmatige link toe op CPL-activiteit (merge array).
 */
async function appendUserLinkOnCplActivity(activityId, link) {
  const { buildUserLink } = require("./fietsklimUserLinksSchema");
  const ref = getCplFirestore().collection("activities").doc(String(activityId));
  const snap = await ref.get();
  if (!snap.exists) {
    throw new Error("CPL activity not found");
  }
  const data = snap.data();
  const existing = userLinksFromActivityData(data);
  const next = buildUserLink(link);
  const dup = existing.some((e) => e.datasetId === next.datasetId && e.climbId === next.climbId);
  const merged = dup
    ? existing.map((e) =>
        e.datasetId === next.datasetId && e.climbId === next.climbId
          ? { ...e, linked_at: next.linked_at, climbName: next.climbName || e.climbName }
          : e
      )
    : [...existing, next];
  await ref.set({ fietsklim_user_links: merged }, { merge: true });
  return { links: merged };
}

function journalEntryToHit(entry) {
  const latest = latestAscent(entry);
  if (!latest) return null;
  return {
    activity: {
      id: latest.activity_id,
      cplActivityId: latest.activity_id,
      name: latest.activity_name || null,
      strava_id: latest.strava_id ?? null,
      start_date_local: latest.activity_start_at
        ? new Date(latest.activity_start_at).toISOString()
        : null,
    },
    coverage: latest.coverage,
    climbName: entry.climbName,
    journal: entry,
  };
}

module.exports = {
  claimsFromActivity,
  applyActivitiesToCplJournal,
  fetchJournalEntries,
  fetchAllJournalEntries,
  appendUserLinkOnCplActivity,
  journalEntryToHit,
  journalCollection,
};
