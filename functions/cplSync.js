const functions = require("firebase-functions");
const admin = require("firebase-admin");
const {
  cplCfg,
  cplSyncConfigured,
  getCplFirestore,
  resolveCplOwnerFromContext,
  resolveCplOwner,
  authIdentityFromContext,
  cplProjectId,
} = require("./cplClient");
const {
  cplActivityToMatchRecord,
  summaryMatchesFromMap,
} = require("./cplMatch");
const { fietsklimMatchFromActivityData } = require("./fietsklimMatchSchema");
const { ensureFietsklimMatchOnCplActivity } = require("./cplMatchOnCpl");

function polylineHintPresent(raw) {
  if (raw == null) return false;
  if (typeof raw === "object" && raw.summary_polyline) {
    return String(raw.summary_polyline).trim().length > 0;
  }
  const s = String(raw).trim();
  return s.length > 0 && s !== "[object Object]";
}

const REGION = "europe-west1";
const ALL_DATASETS_TOKEN = "__all__";
const CPL_ACTIVITIES_PAGE_SIZE = 60;
function allowedEmail(email) {
  const cfg = functions.config().auth || {};
  const list = (cfg.allowed_emails || "vr.deruiter@gmail.com")
    .split(",")
    .map((s) => s.trim().toLowerCase());
  return email && list.includes(email.trim().toLowerCase());
}

function requireAuth(context) {
  if (!context.auth?.token?.email) {
    throw new functions.https.HttpsError("unauthenticated", "Log in met Google.");
  }
  if (!allowedEmail(context.auth.token.email)) {
    throw new functions.https.HttpsError("permission-denied", "Geen toegang.");
  }
  return { uid: context.auth.uid, email: context.auth.token.email.trim() };
}

function logDocId(datasetId, climbId) {
  return `${datasetId}__${climbId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 450);
}

function integrationRef(uid) {
  return admin.firestore().collection("users").doc(uid).collection("integrations").doc("cpl");
}

function parseActivityEpochBounds(data) {
  const afterMs = data?.after != null && data.after !== "" ? Number(data.after) : null;
  const beforeMs = data?.before != null && data.before !== "" ? Number(data.before) : null;
  if (afterMs != null && beforeMs != null && Number.isFinite(afterMs) && Number.isFinite(beforeMs) && afterMs >= beforeMs) {
    throw new functions.https.HttpsError("invalid-argument", "Datum ‘tot’ moet na ‘van’ liggen.");
  }
  return {
    afterMs: afterMs != null && Number.isFinite(afterMs) ? afterMs : null,
    beforeMs: beforeMs != null && Number.isFinite(beforeMs) ? beforeMs : null,
  };
}

function ymdFromMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Ritdatum voor CPL Firestore `date` (YYYY-MM-DD) — zelfde kalenderdag als UI date-input (lokaal). */
function ymdFromMsLocal(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Exclusive upper bound for Firestore `date` strings that include time (2022-06-04T…). */
function ymdDayAfterLocal(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return ymdFromMsLocal(d.getTime());
}

function cplDateRawString(data) {
  const raw = data?.date ?? data?.start_date_local ?? data?.start_date;
  if (raw == null) return null;
  if (typeof raw.toDate === "function") {
    try {
      const d = raw.toDate();
      if (d instanceof Date && Number.isFinite(d.getTime())) return d.toISOString();
    } catch {
      /* ignore */
    }
  }
  if (raw instanceof Date && Number.isFinite(raw.getTime())) return raw.toISOString();
  const s = String(raw).trim();
  return s || null;
}

function activityCalendarYmd(data) {
  const s = cplDateRawString(data);
  if (!s) return null;
  if (s.includes("T")) return s.slice(0, 10);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function activityDateMsFromCpl(data) {
  const s = cplDateRawString(data);
  if (!s) return null;
  const t = Date.parse(s.includes("T") ? s : `${s.slice(0, 10)}T12:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

/** Firestore `startAfter` for orderBy `date` must use the stored field value, not YMD-only. */
function activityDateCursorValue(data) {
  const s = cplDateRawString(data);
  return s || null;
}

function activityInBounds(data, afterMs, beforeMs) {
  const t = activityDateMsFromCpl(data);
  if (t == null) return afterMs == null && beforeMs == null;
  if (afterMs != null && t < afterMs) return false;
  if (beforeMs != null && t > beforeMs) return false;
  return true;
}

async function loadDataset(datasetId) {
  const strava = require("./strava");
  if (typeof strava.loadDataset === "function") {
    return strava.loadDataset(datasetId);
  }
  throw new functions.https.HttpsError("internal", "loadDataset niet beschikbaar — deploy strava.js.");
}

async function loadRegionDatasetIds() {
  const strava = require("./strava");
  if (typeof strava.loadRegionDatasetIds === "function") {
    return strava.loadRegionDatasetIds();
  }
  throw new functions.https.HttpsError("internal", "loadRegionDatasetIds niet beschikbaar.");
}

function logFieldTimestampMillis(v) {
  if (v == null) return 0;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v.toMillis === "function") return v.toMillis();
  return 0;
}

function activityStartMillis(activity) {
  if (!activity) return null;
  const raw = activity.start_date_local || activity.start_date;
  if (!raw) return null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : null;
}

function buildCplLogPatch(datasetId, climbId, hit, data, nowMs, journalEntry) {
  const doneUpdatedAt = logFieldTimestampMillis(data.doneUpdatedAt);
  const wishlistUpdatedAt = logFieldTimestampMillis(data.wishlistUpdatedAt);
  const act = hit.activity;
  const newCplId = String(act.cplActivityId || act.id || "");
  const prevCplId = data.cplActivityId ? String(data.cplActivityId) : null;
  let ascentCount = Number(data.cplAscentCount) || 0;
  if (journalEntry && Number.isFinite(journalEntry.ascent_count)) {
    ascentCount = Math.max(1, journalEntry.ascent_count);
  } else if (!prevCplId) ascentCount = 1;
  else if (newCplId && newCplId !== prevCplId) ascentCount += 1;

  const patch = {
    datasetId,
    climbId,
    source: "cpl",
    cplActivityId: newCplId,
    cplActivityName: act.name || null,
    cplClimbName: hit.climbName || null,
    cplAscentCount: ascentCount,
    matchCoverage: hit.coverage,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const stravaId = act.strava_id;
  if (stravaId) {
    patch.stravaActivityId = Number(stravaId) || stravaId;
    patch.stravaActivityName = act.name || null;
    patch.stravaClimbName = hit.climbName || null;
  }

  const startAt = activityStartMillis(act);
  const lastRideAt =
    journalEntry?.last_ascent_at != null && Number.isFinite(journalEntry.last_ascent_at)
      ? journalEntry.last_ascent_at
      : startAt;
  const firstClaimAt =
    journalEntry?.first_claimed_at != null && Number.isFinite(journalEntry.first_claimed_at)
      ? journalEntry.first_claimed_at
      : startAt;

  if (lastRideAt != null) {
    patch.cplActivityStartAt = lastRideAt;
    if (stravaId) patch.stravaActivityStartAt = lastRideAt;
  }
  if (firstClaimAt != null) {
    patch.cplFirstClaimedAt = firstClaimAt;
  }

  if (nowMs >= doneUpdatedAt) {
    patch.done = true;
    patch.doneUpdatedAt = firstClaimAt != null ? firstClaimAt : lastRideAt != null ? lastRideAt : nowMs;
  } else if (firstClaimAt != null && Boolean(data.done)) {
    patch.doneUpdatedAt = firstClaimAt;
  }
  if (nowMs >= wishlistUpdatedAt) {
    patch.wishlist = false;
    patch.wishlistUpdatedAt = nowMs;
  }

  const nextDone = patch.done !== undefined ? patch.done : Boolean(data.done);
  const nextWishlist = patch.wishlist !== undefined ? patch.wishlist : Boolean(data.wishlist);
  if (!nextDone && !nextWishlist) {
    return { delete: true, patch: null };
  }
  return { delete: false, patch };
}

async function writeCplMatches(uid, datasetId, bestByClimb) {
  const db = admin.firestore();
  const logCol = db.collection("users").doc(uid).collection("climbLog");
  const entries = [...bestByClimb.entries()];
  if (!entries.length) return;
  const nowMs = Date.now();
  const CHUNK = 100;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK);
    const refs = slice.map(([climbId]) => logCol.doc(logDocId(datasetId, climbId)));
    const snaps = await db.getAll(...refs);
    const batch = db.batch();
    for (let j = 0; j < slice.length; j += 1) {
      const [climbId, hit] = slice[j];
      const row = snaps[j].exists ? snaps[j].data() : {};
      const journalEntry = hit.journal || null;
      const { delete: del, patch } = buildCplLogPatch(
        datasetId,
        climbId,
        hit,
        row,
        nowMs,
        journalEntry
      );
      if (del) batch.delete(refs[j]);
      else batch.set(refs[j], patch, { merge: true });
    }
    await batch.commit();
  }
}

async function writeFietsklimLogFromJournal(uid, journalEntries) {
  const { journalEntryToHit } = require("./cplClimbJournal");
  const byDataset = new Map();
  for (const entry of journalEntries || []) {
    const hit = journalEntryToHit(entry);
    if (!hit) continue;
    hit.journal = entry;
    let byClimb = byDataset.get(entry.datasetId);
    if (!byClimb) {
      byClimb = new Map();
      byDataset.set(entry.datasetId, byClimb);
    }
    byClimb.set(entry.climbId, hit);
  }
  let matchesWritten = 0;
  const matches = [];
  for (const [datasetId, bestByClimb] of byDataset.entries()) {
    if (!bestByClimb.size) continue;
    await writeCplMatches(uid, datasetId, bestByClimb);
    matchesWritten += bestByClimb.size;
    matches.push(...summaryMatchesFromMap(datasetId, bestByClimb));
  }
  return { matchesWritten, matches };
}

function authoritativeFromActivityDocs(activityDocs, regionIds) {
  const { claimsFromActivity } = require("./cplClimbJournal");
  const regionSet = new Set(regionIds);
  const authoritative = new Set();
  for (const row of activityDocs || []) {
    const claims = claimsFromActivity(row.id, row.data, row.matchAct);
    for (const c of claims) {
      if (regionSet.has(c.datasetId)) {
        authoritative.add(logDocId(c.datasetId, c.climbId));
      }
    }
  }
  return authoritative;
}

async function fetchAllCplActivityDocsInBounds(cplOwnerId, bounds, routeMapPolicy = "default") {
  const all = [];
  let cursor = null;
  for (let guard = 0; guard < 500; guard += 1) {
    const page = await fetchCplActivitiesPage(cplOwnerId, {
      afterMs: bounds.afterMs,
      beforeMs: bounds.beforeMs,
      routeMapPolicy,
      startAfterDate: cursor?.startAfterDate,
      startAfterId: cursor?.startAfterId,
    });
    all.push(...(page.activityDocs || []));
    if (page.completed || !page.cursor) break;
    cursor = page.cursor;
  }
  return all;
}

/**
 * Na afgeronde periode-sync: verwijder CPL-logboekregels in die periode die niet opnieuw matchen
 * (bv. Karellis na zuidwaartse rit — oude fout van eerdere hele-database run).
 */
function authoritativeLogIdsFromHits(hits, regionIds) {
  const regionSet = new Set(regionIds);
  const authoritative = new Set();
  for (const h of hits || []) {
    if (!regionSet.has(h.datasetId)) continue;
    authoritative.add(logDocId(h.datasetId, h.climbId));
  }
  return authoritative;
}

async function reconcileCplLogbookForPeriod(uid, bounds, regionIds, authoritative) {

  const logCol = admin.firestore().collection("users").doc(uid).collection("climbLog");
  const snap = await logCol.get();
  let removed = 0;
  const batch = admin.firestore().batch();
  let ops = 0;
  for (const doc of snap.docs) {
    const row = doc.data();
    if (row?.source !== "cpl") continue;
    const startMs =
      typeof row.cplActivityStartAt === "number"
        ? row.cplActivityStartAt
        : typeof row.stravaActivityStartAt === "number"
          ? row.stravaActivityStartAt
          : null;
    if (startMs == null) continue;
    if (bounds.afterMs != null && startMs < bounds.afterMs) continue;
    if (bounds.beforeMs != null && startMs > bounds.beforeMs) continue;
    if (authoritative.has(doc.id)) continue;
    batch.delete(doc.ref);
    removed += 1;
    ops += 1;
    if (ops >= 400) {
      await batch.commit();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  return { removed, authoritativeCount: authoritative.size };
}

/**
 * Match op CPL (fietsklim_match), update fietsklim_journal op CPL, importeer journal → FietsKlim climbLog.
 * @param {{ id: string, data: object, matchAct: object }[]} activityDocs
 */
async function matchAndImportActivityDocs(uid, cplOwnerId, activityDocs, regionIds, opts = {}) {
  const strava = require("./strava");
  const { applyActivitiesToCplJournal } = require("./cplClimbJournal");
  const datasetCache = new Map();
  const matchCtx = {
    fetchDataJson: strava.fetchDataJson,
    loadDataset,
    routeMapPolicy: opts.routeMapPolicy || "default",
    force: Boolean(opts.force),
    persist: opts.persist !== false,
    datasetCache,
  };

  const rowsForJournal = [];
  let cplMatchWrites = 0;
  let cplMatchCached = 0;
  let skippedNoRoute = 0;

  const importOnly = Boolean(opts.importOnly);

  for (const row of activityDocs || []) {
    const { id, data, matchAct } = row;
    const hasPolyline = Boolean(matchAct?.map?.summary_polyline);
    const stored = fietsklimMatchFromActivityData(data);
    const hasUserLinks = (data?.fietsklim_user_links?.length || 0) > 0;

    if (importOnly) {
      if (stored?.computed_at || hasUserLinks) {
        rowsForJournal.push(row);
      } else {
        skippedNoRoute += 1;
      }
      continue;
    }

    if (hasPolyline) {
      const result = await ensureFietsklimMatchOnCplActivity(id, data, regionIds, matchCtx);
      if (result.skipped === "cached_on_cpl") cplMatchCached += 1;
      else if (!result.skipped) cplMatchWrites += 1;
      rowsForJournal.push({
        id,
        data: result.block
          ? { ...data, fietsklim_match: result.block }
          : data,
        matchAct: result.matchAct,
      });
    } else if (stored?.computed_at || hasUserLinks) {
      rowsForJournal.push(row);
    } else {
      skippedNoRoute += 1;
    }
  }

  const journalPersist = opts.journalPersist !== false;
  const { entries: journalEntries } = await applyActivitiesToCplJournal(cplOwnerId, rowsForJournal, {
    persist: journalPersist,
    regionIds,
  });

  const { matchesWritten, matches } = await writeFietsklimLogFromJournal(uid, journalEntries);
  const datasetsProcessed = [...new Set(journalEntries.map((e) => e.datasetId))];
  const authoritative = authoritativeFromActivityDocs(rowsForJournal, regionIds);

  return {
    matchesWritten,
    datasetsProcessed,
    matches,
    cplMatchWrites,
    cplMatchCached,
    skippedNoRoute,
    journalEntriesWritten: journalEntries.length,
    authoritative,
  };
}

/**
 * @param {string} cplOwnerId
 * @param {{ afterMs?: number|null, beforeMs?: number|null, pageSize?: number, startAfterDate?: string|null, startAfterId?: string|null }} opts
 */
function normalizeRouteMapPolicy(raw) {
  if (raw === "intervals_only" || raw === "strava_only") return raw;
  return "default";
}

async function fetchCplActivitiesPage(cplOwnerId, opts = {}) {
  const routeMapPolicy = normalizeRouteMapPolicy(opts.routeMapPolicy);
  const pageSize = Math.min(Math.max(1, opts.pageSize || CPL_ACTIVITIES_PAGE_SIZE), 120);
  const db = getCplFirestore();
  let q = db.collection("activities").where("ownerId", "==", cplOwnerId).orderBy("date", "desc");

  const fromYmd = ymdFromMsLocal(opts.afterMs);
  const toExclusiveYmd = opts.beforeMs != null ? ymdDayAfterLocal(opts.beforeMs) : null;
  if (fromYmd) q = q.where("date", ">=", fromYmd);
  if (toExclusiveYmd) q = q.where("date", "<", toExclusiveYmd);

  q = q.limit(pageSize + 5);

  if (opts.startAfterDate && opts.startAfterId) {
    q = q.startAfter(String(opts.startAfterDate), String(opts.startAfterId));
  }

  let snap;
  try {
    snap = await q.get();
  } catch (e) {
    functions.logger.warn("fetchCplActivitiesPage indexed query failed", e?.message || e);
    if (fromYmd || toExclusiveYmd) {
      return {
        activities: [],
        ridesWithMap: 0,
        scannedDocs: 0,
        completed: true,
        cursor: null,
        dateQueryIndexRequired: true,
      };
    }
    q = db
      .collection("activities")
      .where("ownerId", "==", cplOwnerId)
      .orderBy("date", "desc")
      .limit(pageSize + 20);
    if (opts.startAfterDate && opts.startAfterId) {
      q = q.startAfter(String(opts.startAfterDate), String(opts.startAfterId));
    }
    snap = await q.get();
  }

  const records = [];
  /** @type {{ id: string, data: object, matchAct: object }[]} */
  const activityDocs = [];
  let skippedNoMap = 0;
  let skippedOutOfBounds = 0;
  /** @type {{ id: string, title: string|null, date: string|null, hasIntervalsMap: boolean, hasStravaMap: boolean }[]} */
  const noMapSamples = [];
  const fromYmdFilter = fromYmd;
  const toYmdFilter = opts.beforeMs != null ? ymdFromMsLocal(opts.beforeMs) : null;
  for (const doc of snap.docs) {
    const data = doc.data();
    if (fromYmdFilter || toYmdFilter) {
      const ymd = activityCalendarYmd(data);
      if (ymd) {
        if (fromYmdFilter && ymd < fromYmdFilter) {
          skippedOutOfBounds += 1;
          continue;
        }
        if (toYmdFilter && ymd > toYmdFilter) {
          skippedOutOfBounds += 1;
          continue;
        }
      }
    }
    if (!activityInBounds(data, opts.afterMs ?? null, opts.beforeMs ?? null)) {
      skippedOutOfBounds += 1;
      continue;
    }
    const matchAct = cplActivityToMatchRecord(doc.id, data, routeMapPolicy);
    const storedMatch = fietsklimMatchFromActivityData(data);
    const hasStoredMatch = Boolean(storedMatch?.computed_at);
    if (matchAct.map?.summary_polyline) {
      records.push(matchAct);
      activityDocs.push({ id: doc.id, data, matchAct });
    } else if (hasStoredMatch) {
      activityDocs.push({ id: doc.id, data, matchAct });
    } else {
      skippedNoMap += 1;
      if (noMapSamples.length < 5) {
        const d = doc.data();
        noMapSamples.push({
          id: doc.id,
          title: d?.title || d?.name || null,
          date: cplDateRawString(d),
          hasIntervalsMap: Boolean(polylineHintPresent(d?.intervals_map)),
          hasStravaMap: Boolean(polylineHintPresent(d?.strava_map)),
        });
      }
    }
    if (activityDocs.length >= pageSize) break;
  }

  const lastDoc = snap.docs[snap.docs.length - 1];
  const lastData = lastDoc?.data();
  const completed = snap.empty || snap.docs.length < pageSize + 5;
  const cursor =
    lastDoc && !completed
      ? {
          startAfterDate: activityDateCursorValue(lastData) || null,
          startAfterId: lastDoc.id,
        }
      : null;

  return {
    activities: records,
    activityDocs,
    ridesWithMap: records.length,
    scannedDocs: snap.docs.length,
    skippedNoMap,
    skippedOutOfBounds,
    noMapSamples,
    completed: completed || !cursor,
    cursor,
  };
}

async function resolveCplOwnerForUid(uid, identityOrContext) {
  let owner = null;
  if (identityOrContext?.auth) {
    owner = await resolveCplOwnerFromContext(identityOrContext);
  } else if (typeof identityOrContext === "string") {
    owner = await resolveCplOwner({ email: identityOrContext });
  } else {
    owner = await resolveCplOwner(identityOrContext || {});
  }
  if (!owner) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Geen Climb Performance Lab-account gevonden voor dit Google-account. Log in bij CPL (zelfde Google) en controleer Authentication → Users in project climb-performance-lab."
    );
  }
  await integrationRef(uid).set(
    {
      cplOwnerId: owner.uid,
      cplEmail: owner.email,
      cplMatchedVia: owner.matchedVia || null,
      linkedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return owner.uid;
}

async function runCplSyncBatch(uid, identityOrEmail, data) {
  const datasetId = String(data.datasetId || "").trim();
  if (datasetId !== ALL_DATASETS_TOKEN) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "CPL-sync ondersteunt alleen hele database (__all__)."
    );
  }

  const bounds = parseActivityEpochBounds(data);
  const reset = Boolean(data.reset);
  const cplOwnerId = await resolveCplOwnerForUid(uid, identityOrEmail);

  const integrationSnap = await integrationRef(uid).get();
  const integration = integrationSnap.exists ? integrationSnap.data() : {};
  const prev = integration?.fullSyncCursor;

  let activityCursor = null;
  const routeMapPolicy = normalizeRouteMapPolicy(data.routeMapPolicy ?? prev?.routeMapPolicy);
  const importOnly = Boolean(data.importOnly);

  if (!reset && prev?.mode === "all") {
    activityCursor = prev.activityCursor || null;
  }

  const page = await fetchCplActivitiesPage(cplOwnerId, {
    afterMs: bounds.afterMs,
    beforeMs: bounds.beforeMs,
    routeMapPolicy,
    startAfterDate: activityCursor?.startAfterDate,
    startAfterId: activityCursor?.startAfterId,
  });

  if (page.dateQueryIndexRequired) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "CPL datumbereik: maak in project climb-performance-lab een Firestore composite index op collection activities: ownerId (Ascending) + date (Descending). Zie docs/cpl-firestore-index-578c/README.md"
    );
  }

  const { ids: regionIds, totalClimbs, regionCount } = await loadRegionDatasetIds();

  const hasDateBounds = bounds.afterMs != null || bounds.beforeMs != null;
  const activityDocs = page.activityDocs || [];
  let {
    matchesWritten,
    matches: batchMatches,
    cplMatchWrites,
    cplMatchCached,
    skippedNoRoute,
    journalEntriesWritten,
    authoritative,
  } = await matchAndImportActivityDocs(uid, cplOwnerId, activityDocs, regionIds, {
    routeMapPolicy,
    force: Boolean(data.forceRematch),
    importOnly,
    persist: !importOnly,
  });

  let syncCompleted = false;
  let nextActivityCursor = activityCursor;

  if (page.completed) {
    syncCompleted = true;
    nextActivityCursor = null;
  } else {
    nextActivityCursor = page.cursor;
  }

  const fullSyncCursor = syncCompleted
    ? null
    : {
        mode: "all",
        activityCursor: nextActivityCursor,
        afterMs: bounds.afterMs,
        beforeMs: bounds.beforeMs,
        routeMapPolicy,
        updatedAt: new Date().toISOString(),
      };

  let fullJournalImport = null;
  if (syncCompleted && !hasDateBounds) {
    try {
      const { fetchAllJournalEntries } = require("./cplClimbJournal");
      const allJournal = await fetchAllJournalEntries(cplOwnerId);
      const imp = await writeFietsklimLogFromJournal(uid, allJournal);
      fullJournalImport = {
        journalEntries: allJournal.length,
        matchesWritten: imp.matchesWritten,
      };
      matchesWritten = imp.matchesWritten;
      batchMatches = imp.matches.slice(0, 120);
    } catch (e) {
      functions.logger.warn("fullJournalImport", e?.message || e);
      fullJournalImport = { error: String(e?.message || e) };
    }
  }

  let periodReconcile = null;
  if (syncCompleted && hasDateBounds) {
    try {
      const periodDocs = await fetchAllCplActivityDocsInBounds(cplOwnerId, bounds, routeMapPolicy);
      const periodImport = await matchAndImportActivityDocs(uid, cplOwnerId, periodDocs, regionIds, {
        routeMapPolicy,
        force: Boolean(data.forceRematch),
        importOnly,
        persist: !importOnly,
      });
      periodReconcile = await reconcileCplLogbookForPeriod(
        uid,
        bounds,
        regionIds,
        periodImport.authoritative
      );
    } catch (e) {
      functions.logger.warn("reconcileCplLogbookForPeriod", e?.message || e);
      periodReconcile = { error: String(e?.message || e) };
    }
  }

  const ridesScanned = activityDocs.length;
  const summary = {
    kind: "full",
    source: "cpl",
    routeMapPolicy,
    datasetId: ALL_DATASETS_TOKEN,
    allDatasets: true,
    regionCount,
    totalClimbs,
    activitiesScanned: ridesScanned,
    activitiesWithMap: ridesScanned,
    docsScanned: page.scannedDocs,
    skippedNoMap: page.skippedNoMap ?? 0,
    skippedNoRoute,
    skippedOutOfBounds: page.skippedOutOfBounds ?? 0,
    noMapSamples: page.noMapSamples ?? [],
    cplMatchWrites,
    cplMatchCached,
    journalEntriesWritten,
    fullJournalImport,
    importOnly,
    completed: syncCompleted,
    matchesWritten,
    uniqueClimbs: matchesWritten,
    matches: batchMatches.slice(0, 120),
    after: bounds.afterMs,
    before: bounds.beforeMs,
    dateQueryIndexRequired: Boolean(page.dateQueryIndexRequired),
    regionProgress: syncCompleted ? `${regionCount}/${regionCount} regio’s` : `regio’s: alle ${regionCount}`,
    periodReconcile,
  };

  await integrationRef(uid).set(
    {
      lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
      lastSyncSummary: summary,
      fullSyncCursor,
    },
    { merge: true }
  );

  let msg;
  if (page.dateQueryIndexRequired) {
    msg =
      "CPL-sync: datumbereik-query mislukt (Firestore-index ownerId+date ontbreekt in climb-performance-lab). Zie Functions-log fetchCplActivitiesPage.";
  } else if (syncCompleted && ridesScanned === 0 && hasDateBounds) {
    msg =
      "CPL-sync klaar: 0 ritten met route in deze periode (controleer CPL-activiteit: intervals_map/strava_map + ownerId + datum).";
  } else if (syncCompleted) {
    msg = `CPL-sync klaar: ${matchesWritten} match(es) · ${ridesScanned} rit(ten) met route · ${regionCount} regio’s.`;
  } else {
    msg = `CPL-sync batch: ${matchesWritten} match(es), ${ridesScanned} rit(ten) verwerkt, ${regionCount} regio’s.`;
  }

  return { ok: true, completed: syncCompleted, message: msg, summary };
}

exports.cplLinkClimbOnActivity = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 120, memory: "512MB" })
  .https.onCall(async (data, context) => {
    const { uid } = requireAuth(context);
    const activityId = String(data.cplActivityId || data.activityId || "").trim();
    const datasetId = String(data.datasetId || "").trim();
    const climbId = String(data.climbId || "").trim();
    if (!activityId || !datasetId || !climbId) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "cplActivityId, datasetId en climbId zijn verplicht."
      );
    }
    const cplOwnerId = await resolveCplOwnerForUid(uid, authIdentityFromContext(context));
    const db = getCplFirestore();
    const actSnap = await db.collection("activities").doc(activityId).get();
    if (!actSnap.exists) {
      throw new functions.https.HttpsError("not-found", "CPL-activiteit niet gevonden.");
    }
    const actData = actSnap.data();
    if (String(actData.ownerId) !== String(cplOwnerId)) {
      throw new functions.https.HttpsError("permission-denied", "Deze rit hoort niet bij jouw CPL-account.");
    }
    const { appendUserLinkOnCplActivity, applyActivitiesToCplJournal } = require("./cplClimbJournal");
    await appendUserLinkOnCplActivity(activityId, {
      datasetId,
      climbId,
      climbName: data.climbName || null,
      note: data.note || null,
    });
    const fresh = await db.collection("activities").doc(activityId).get();
    const matchAct = cplActivityToMatchRecord(activityId, fresh.data(), "default");
    const { ids: regionIds } = await loadRegionDatasetIds();
    const { entries } = await applyActivitiesToCplJournal(
      cplOwnerId,
      [{ id: activityId, data: fresh.data(), matchAct }],
      { persist: true, regionIds }
    );
    const imp = await writeFietsklimLogFromJournal(uid, entries);
    return {
      ok: true,
      activityId,
      datasetId,
      climbId,
      journalEntries: entries.length,
      matchesWritten: imp.matchesWritten,
    };
  });

exports.getCplStatus = functions.region(REGION).https.onCall(async (_data, context) => {
  const { uid, email } = requireAuth(context);
  let cplOwner = null;
  let linkReason = null;
  let linkHint = null;
  const identity = authIdentityFromContext(context);
  try {
    cplOwner = await resolveCplOwnerFromContext(context);
    if (!cplOwner) {
      linkReason = "no_cpl_account";
      linkHint =
        "Geen Firebase Auth-gebruiker in project climb-performance-lab voor deze Google-login. Controleer CPL → Authentication → Users, of log opnieuw in bij CPL.";
    }
  } catch (e) {
    functions.logger.warn("getCplStatus resolveCplOwner", e);
    const code = e?.code || "";
    if (code === "auth/user-not-found") {
      linkReason = "no_cpl_account";
      linkHint = linkHint || "Geen CPL-account voor deze mail.";
    } else if (/permission|forbidden|insufficient/i.test(String(code) + String(e?.message))) {
      linkReason = "cpl_auth_lookup_denied";
      linkHint =
        "Server kan CPL-gebruiker niet opzoeken (IAM: Firebase Auth Admin op project climb-performance-lab).";
    } else {
      linkReason = "lookup_failed";
      linkHint = "CPL-status tijdelijk niet op te halen — zie Functions-logs.";
    }
  }
  let activeSyncJob = null;
  try {
    activeSyncJob = await require("./cplBackgroundSync").getActiveSyncJob(uid);
  } catch (e) {
    functions.logger.warn("getCplStatus activeSyncJob", e);
  }
  const integ = await integrationRef(uid).get();
  const data = integ.exists ? integ.data() : {};
  const serverSyncConfigured = Boolean(cplCfg().worker_secret);
  if (cplOwner && !serverSyncConfigured) {
    linkHint =
      "CPL-account gevonden, maar server-sync niet geconfigureerd (cpl.worker_secret op climb-database).";
  } else if (cplOwner && serverSyncConfigured) {
    linkHint = "Routes uit CPL: Intervals-map, anders Strava-map (geen Strava API bij hele database).";
  }
  return {
    linked: Boolean(cplOwner),
    emailChecked: identity.email || email,
    googleUidChecked: identity.googleUid || null,
    matchedVia: cplOwner?.matchedVia || null,
    cplProjectId: cplProjectId(),
    linkReason,
    linkHint,
    cplOwnerId: cplOwner?.uid || data.cplOwnerId || null,
    lastSyncAt: data.lastSyncAt?.toDate?.()?.toISOString?.() || null,
    lastSyncSummary: data.lastSyncSummary || null,
    fullSyncCursor: data.fullSyncCursor || null,
    activeSyncJob,
    serverSyncConfigured,
    routePriority: "intervals_map_then_strava_map",
  };
});

exports.runCplSyncBatch = runCplSyncBatch;

Object.assign(exports, require("./cplBackgroundSync"));

// Export helpers for tests
exports.buildCplLogPatch = buildCplLogPatch;
exports.ALL_DATASETS_TOKEN = ALL_DATASETS_TOKEN;
exports.matchAndImportActivityDocs = matchAndImportActivityDocs;
exports.authoritativeLogIdsFromHits = authoritativeLogIdsFromHits;
