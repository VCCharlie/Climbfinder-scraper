/**
 * Fase 1 — handmatig logboek: welke klimmen zijn gedaan / op wishlist (per Google-account).
 * Firestore: users/{uid}/climbLog/{datasetId__climbId}
 * Fallback: localStorage als Firestore niet beschikbaar is.
 */
(function (global) {
  const STORAGE_VERSION = 1;
  const FIRESTORE_PREF_KEY = "fietsklim-log-use-firestore";

  const state = {
    ready: false,
    uid: null,
    email: null,
    byKey: new Map(),
    unsubscribe: null,
    mode: "none",
  };

  function cfg() {
    return global.FIETSKLIM_AUTH_CONFIG || {};
  }

  /** Standaard localStorage; Firestore alleen als toggle aan (of eenmalig uit firebase-config). */
  function isFirestoreSyncRequested() {
    try {
      const v = localStorage.getItem(FIRESTORE_PREF_KEY);
      if (v === "1") return true;
      if (v === "0") return false;
    } catch {
      /* ignore */
    }
    if (cfg().climbLog?.useFirestore === true) {
      try {
        localStorage.setItem(FIRESTORE_PREF_KEY, "1");
      } catch {
        /* ignore */
      }
      return true;
    }
    return false;
  }

  function setFirestoreSyncRequested(on) {
    try {
      localStorage.setItem(FIRESTORE_PREF_KEY, on ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  function syncStatusSummary() {
    const requested = isFirestoreSyncRequested();
    const active = state.mode;
    const counts = `${totalDone()} gedaan, ${totalWishlist()} wishlist`;
    if (!state.ready) {
      return { line: "Sync: laden…", ok: false, requestedFirestore: requested, activeMode: active };
    }
    if (!requested) {
      return {
        line: `Sync: localStorage · ${counts}`,
        ok: true,
        requestedFirestore: false,
        activeMode: active,
      };
    }
    if (active === "firestore") {
      return {
        line: `Sync: Firestore · actief · ${counts}`,
        ok: true,
        requestedFirestore: true,
        activeMode: "firestore",
      };
    }
    return {
      line: `Sync: Firestore aan, maar localStorage (geen cloud) · ${counts}`,
      ok: false,
      requestedFirestore: true,
      activeMode: active,
    };
  }

  function climbKey(datasetId, climbId) {
    return `${datasetId}::${climbId}`;
  }

  function logDocId(datasetId, climbId) {
    const raw = `${datasetId}__${climbId}`;
    return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 450);
  }

  function datasetIdFromRegionUrl(regionUrl) {
    if (!regionUrl) return "";
    const m = String(regionUrl).match(/data\/([^/?#]+)\.json/i);
    return m ? m[1] : regionUrl.replace(/^data\//, "").replace(/\.json$/, "");
  }

  function dispatchChanged() {
    global.dispatchEvent(new CustomEvent("fietsklim-climb-log-changed"));
  }

  function shouldPersist(row) {
    return Boolean(row?.done || row?.wishlist);
  }

  function getEntry(datasetId, climbId) {
    if (!datasetId || !climbId) return null;
    return state.byKey.get(climbKey(datasetId, climbId)) || null;
  }

  function localStorageKey() {
    const email = state.email;
    return email ? `fietsklim-climb-log-v${STORAGE_VERSION}-${email}` : "";
  }

  function migrationStorageKey() {
    return state.uid ? `fietsklim-log-migrated-v${STORAGE_VERSION}-${state.uid}` : "";
  }

  /** Leest localStorage zonder state.byKey te wijzigen (voor Firestore-migratie). */
  function readLocalRowsFromStorage() {
    const key = localStorageKey();
    if (!key) return [];
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      const data = JSON.parse(raw);
      const out = [];
      for (const row of data.entries || []) {
        if (row.datasetId && row.climbId && shouldPersist(row)) {
          out.push({
            ...row,
            done: Boolean(row.done),
            wishlist: Boolean(row.wishlist),
            source: row.source || "manual",
          });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  function loadLocal() {
    state.byKey.clear();
    for (const row of readLocalRowsFromStorage()) {
      state.byKey.set(climbKey(row.datasetId, row.climbId), row);
    }
  }

  async function migrateLocalRowsToFirestore(rows) {
    if (!rows.length || !firebase.firestore || !state.uid) return 0;
    const db = firebase.firestore();
    const col = db.collection("users").doc(state.uid).collection("climbLog");
    let written = 0;
    for (let i = 0; i < rows.length; i += 400) {
      const batch = db.batch();
      for (const row of rows.slice(i, i + 400)) {
        const ref = col.doc(logDocId(row.datasetId, row.climbId));
        batch.set(
          ref,
          {
            datasetId: row.datasetId,
            climbId: row.climbId,
            done: Boolean(row.done),
            wishlist: Boolean(row.wishlist),
            source: row.source === "strava" ? "strava" : "migrated",
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        written += 1;
      }
      await batch.commit();
    }
    return written;
  }

  function saveLocal() {
    const email = state.email;
    if (!email) return;
    const entries = [...state.byKey.values()].filter((r) => shouldPersist(r));
    localStorage.setItem(
      `fietsklim-climb-log-v${STORAGE_VERSION}-${email}`,
      JSON.stringify({ version: STORAGE_VERSION, entries })
    );
  }

  function upsertLocal(datasetId, climbId, patch) {
    const key = climbKey(datasetId, climbId);
    const prev = getEntry(datasetId, climbId) || {
      datasetId,
      climbId,
      done: false,
      wishlist: false,
      source: "manual",
    };
    const next = {
      ...prev,
      ...patch,
      datasetId,
      climbId,
      done: Boolean(patch.done != null ? patch.done : prev.done),
      wishlist: Boolean(patch.wishlist != null ? patch.wishlist : prev.wishlist),
      updatedAt: new Date().toISOString(),
    };
    if (shouldPersist(next)) {
      state.byKey.set(key, next);
    } else {
      state.byKey.delete(key);
    }
    saveLocal();
    dispatchChanged();
  }

  function mergeEntryFromFirestore(d) {
    if (!d?.datasetId || !d?.climbId) return;
    const row = {
      ...d,
      done: Boolean(d.done),
      wishlist: Boolean(d.wishlist),
    };
    if (shouldPersist(row)) {
      state.byKey.set(climbKey(d.datasetId, d.climbId), row);
    }
  }

  async function init() {
    if (typeof firebase === "undefined" || !firebase.auth) {
      return false;
    }
    const user = firebase.auth().currentUser;
    if (!user?.uid) {
      return false;
    }

    state.uid = user.uid;
    state.email = user.email || user.uid;

    if (state.unsubscribe) {
      state.unsubscribe();
      state.unsubscribe = null;
    }

    const preferFirestore = isFirestoreSyncRequested();

    if (preferFirestore && firebase.firestore) {
      try {
        const db = firebase.firestore();
        state.mode = "firestore";
        let firstSnapshot = true;
        state.unsubscribe = db
          .collection("users")
          .doc(user.uid)
          .collection("climbLog")
          .onSnapshot(
            async (snap) => {
              if (firstSnapshot) {
                firstSnapshot = false;
                const migKey = migrationStorageKey();
                if (migKey && !localStorage.getItem(migKey) && snap.empty) {
                  const pending = readLocalRowsFromStorage();
                  if (pending.length) {
                    try {
                      const n = await migrateLocalRowsToFirestore(pending);
                      localStorage.setItem(migKey, new Date().toISOString());
                      console.info(`FietsKlim logboek: ${n} vinkje(s) van localStorage naar Firestore.`);
                      return;
                    } catch (err) {
                      console.warn("Climb log migratie:", err.message);
                    }
                  } else if (migKey) {
                    localStorage.setItem(migKey, "empty");
                  }
                }
              }
              state.byKey.clear();
              snap.forEach((doc) => {
                mergeEntryFromFirestore(doc.data());
              });
              state.ready = true;
              dispatchChanged();
            },
            (err) => {
              console.warn("Climb log Firestore:", err.message);
              state.mode = "local";
              loadLocal();
              state.ready = true;
              dispatchChanged();
            }
          );
        return true;
      } catch (err) {
        console.warn("Climb log Firestore init:", err.message);
      }
    }

    state.mode = "local";
    loadLocal();
    state.ready = true;
    dispatchChanged();
    return true;
  }

  function isReady() {
    return state.ready;
  }

  function isDone(datasetId, climbId) {
    return Boolean(getEntry(datasetId, climbId)?.done);
  }

  function isWishlist(datasetId, climbId) {
    return Boolean(getEntry(datasetId, climbId)?.wishlist);
  }

  async function writeFirestore(datasetId, climbId, patch) {
    const db = firebase.firestore();
    const ref = db
      .collection("users")
      .doc(state.uid)
      .collection("climbLog")
      .doc(logDocId(datasetId, climbId));
    const prev = getEntry(datasetId, climbId);
    const next = {
      datasetId,
      climbId,
      done: Boolean(prev?.done),
      wishlist: Boolean(prev?.wishlist),
      source: prev?.source || "manual",
      ...patch,
    };
    next.done = Boolean(patch.done != null ? patch.done : next.done);
    next.wishlist = Boolean(patch.wishlist != null ? patch.wishlist : next.wishlist);
    if (shouldPersist(next)) {
      await ref.set(
        {
          ...next,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } else {
      await ref.delete();
    }
  }

  async function setDone(datasetId, climbId, done) {
    if (!datasetId || !climbId) return;
    if (state.mode === "firestore" && firebase.firestore && state.uid) {
      await writeFirestore(datasetId, climbId, { done: !!done });
      return;
    }
    upsertLocal(datasetId, climbId, { done: !!done });
  }

  async function setWishlist(datasetId, climbId, wishlist) {
    if (!datasetId || !climbId) return;
    if (state.mode === "firestore" && firebase.firestore && state.uid) {
      await writeFirestore(datasetId, climbId, { wishlist: !!wishlist });
      return;
    }
    upsertLocal(datasetId, climbId, { wishlist: !!wishlist });
  }

  /** Atomic update of gedaan + wishlist (één Firestore-write). */
  async function setFlags(datasetId, climbId, flags) {
    if (!datasetId || !climbId) return;
    const patch = {};
    if (flags.done !== undefined) patch.done = !!flags.done;
    if (flags.wishlist !== undefined) patch.wishlist = !!flags.wishlist;
    if (!Object.keys(patch).length) return;
    if (state.mode === "firestore" && firebase.firestore && state.uid) {
      await writeFirestore(datasetId, climbId, patch);
      return;
    }
    upsertLocal(datasetId, climbId, patch);
  }

  function countDoneForDataset(datasetId) {
    if (!datasetId) return 0;
    let n = 0;
    for (const row of state.byKey.values()) {
      if (row.datasetId === datasetId && row.done) n += 1;
    }
    return n;
  }

  function countWishlistForDataset(datasetId) {
    if (!datasetId) return 0;
    let n = 0;
    for (const row of state.byKey.values()) {
      if (row.datasetId === datasetId && row.wishlist) n += 1;
    }
    return n;
  }

  function totalDone() {
    let n = 0;
    for (const row of state.byKey.values()) {
      if (row.done) n += 1;
    }
    return n;
  }

  function totalWishlist() {
    let n = 0;
    for (const row of state.byKey.values()) {
      if (row.wishlist) n += 1;
    }
    return n;
  }

  function teardown() {
    if (state.unsubscribe) {
      state.unsubscribe();
      state.unsubscribe = null;
    }
    state.ready = false;
    state.byKey.clear();
    state.mode = "none";
  }

  function listEntries() {
    return [...state.byKey.values()].filter((r) => shouldPersist(r));
  }

  function exportPayload() {
    return {
      version: STORAGE_VERSION,
      exportedAt: new Date().toISOString(),
      mode: state.mode,
      entries: listEntries(),
    };
  }

  async function importPayload(payload, options) {
    const merge = options?.merge !== false;
    const rows = Array.isArray(payload?.entries) ? payload.entries : [];
    if (!rows.length) return { imported: 0, skipped: 0 };

    let imported = 0;
    let skipped = 0;
    for (const row of rows) {
      if (!row?.datasetId || !row?.climbId) {
        skipped += 1;
        continue;
      }
      const patch = {
        done: Boolean(row.done),
        wishlist: Boolean(row.wishlist),
        source: row.source === "strava" ? "strava" : row.source || "import",
      };
      if (!merge) {
        if (state.mode === "firestore" && firebase.firestore && state.uid) {
          await writeFirestore(row.datasetId, row.climbId, patch);
        } else {
          upsertLocal(row.datasetId, row.climbId, patch);
        }
        imported += 1;
        continue;
      }
      const prev = getEntry(row.datasetId, row.climbId);
      const nextDone = prev?.done || patch.done;
      const nextWishlist = prev?.wishlist || patch.wishlist;
      if (!nextDone && !nextWishlist) {
        skipped += 1;
        continue;
      }
      if (state.mode === "firestore" && firebase.firestore && state.uid) {
        await writeFirestore(row.datasetId, row.climbId, {
          done: nextDone,
          wishlist: nextWishlist,
          source: patch.source,
        });
      } else {
        upsertLocal(row.datasetId, row.climbId, {
          done: nextDone,
          wishlist: nextWishlist,
          source: patch.source,
        });
      }
      imported += 1;
    }
    return { imported, skipped };
  }

  function getMode() {
    return state.mode;
  }

  async function reinit() {
    teardown();
    return init();
  }

  global.FietsKlimClimbLog = {
    init,
    reinit,
    teardown,
    isReady,
    isFirestoreSyncRequested,
    setFirestoreSyncRequested,
    syncStatusSummary,
    isDone,
    isWishlist,
    setDone,
    setWishlist,
    setFlags,
    climbKey,
    logDocId,
    datasetIdFromRegionUrl,
    countDoneForDataset,
    countWishlistForDataset,
    totalDone,
    totalWishlist,
    listEntries,
    exportPayload,
    importPayload,
    getMode,
  };
})(window);
