/**
 * Skip re-matching when activity polyline + dataset revision are unchanged.
 */
const crypto = require("crypto");

function sha256Short(input) {
  return crypto.createHash("sha256").update(String(input || ""), "utf8").digest("hex").slice(0, 24);
}

function polylineFingerprint(encodedPolyline) {
  if (!encodedPolyline) return null;
  return sha256Short(encodedPolyline);
}

function datasetRevisionFingerprint(meta, datasetId) {
  const updated = meta?.updated_at || meta?.updatedAt || "";
  const count = meta?.count != null ? String(meta.count) : "";
  return sha256Short(`${datasetId}|${updated}|${count}`);
}

function matchSkipKey(activityId, datasetId) {
  return `${datasetId}__${activityId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 450);
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} uid
 */
function matchFingerprintCol(db, uid) {
  return db.collection("users").doc(uid).collection("activityMatchFingerprints");
}

async function loadMatchFingerprintMap(db, uid, datasetId, activityIds) {
  const ids = [...new Set((activityIds || []).map((id) => String(id)).filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;
  const col = matchFingerprintCol(db, uid);
  const CHUNK = 30;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const refs = slice.map((actId) => col.doc(matchSkipKey(actId, datasetId)));
    const snaps = await db.getAll(...refs);
    for (let j = 0; j < slice.length; j += 1) {
      if (snaps[j].exists) map.set(slice[j], snaps[j].data());
    }
  }
  return map;
}

function shouldSkipActivityMatch(fingerprintRow, polylineHash, datasetRev) {
  if (!fingerprintRow || !polylineHash || !datasetRev) return false;
  return fingerprintRow.polylineHash === polylineHash && fingerprintRow.datasetRev === datasetRev;
}

async function writeMatchFingerprints(db, uid, datasetId, entries) {
  if (!entries?.length) return;
  const col = matchFingerprintCol(db, uid);
  const CHUNK = 200;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const batch = db.batch();
    for (const row of entries.slice(i, i + CHUNK)) {
      const ref = col.doc(matchSkipKey(row.activityId, datasetId));
      batch.set(
        ref,
        {
          activityId: String(row.activityId),
          datasetId,
          polylineHash: row.polylineHash,
          datasetRev: row.datasetRev,
          skippedMatch: Boolean(row.skippedMatch),
          matchesFound: row.matchesFound ?? 0,
          updatedAtMs: Date.now(),
        },
        { merge: true }
      );
    }
    await batch.commit();
  }
}

module.exports = {
  polylineFingerprint,
  datasetRevisionFingerprint,
  matchSkipKey,
  loadMatchFingerprintMap,
  shouldSkipActivityMatch,
  writeMatchFingerprints,
};
