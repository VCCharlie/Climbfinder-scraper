/**
 * Fase 1 — handmatig logboek: welke klimmen zijn gedaan / op wishlist (per Google-account).
 * Firestore: users/{uid}/climbLog/{datasetId__climbId}
 * Fallback: localStorage als Firestore niet beschikbaar is.
 */
(function (global) {
  const STORAGE_VERSION = 1;

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

  function loadLocal() {
    state.byKey.clear();
    const email = state.email;
    if (!email) return;
    try {
      const raw = localStorage.getItem(`fietsklim-climb-log-v${STORAGE_VERSION}-${email}`);
      if (!raw) return;
      const data = JSON.parse(raw);
      for (const row of data.entries || []) {
        if (row.datasetId && row.climbId && shouldPersist(row)) {
          state.byKey.set(climbKey(row.datasetId, row.climbId), {
            ...row,
            done: Boolean(row.done),
            wishlist: Boolean(row.wishlist),
          });
        }
      }
    } catch {
      /* ignore */
    }
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

    const climbLogCfg = cfg().climbLog || {};
    const preferFirestore = climbLogCfg.useFirestore !== false;

    if (preferFirestore && firebase.firestore) {
      try {
        const db = firebase.firestore();
        state.mode = "firestore";
        state.unsubscribe = db
          .collection("users")
          .doc(user.uid)
          .collection("climbLog")
          .onSnapshot(
            (snap) => {
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

  global.FietsKlimClimbLog = {
    init,
    teardown,
    isReady,
    isDone,
    isWishlist,
    setDone,
    setWishlist,
    climbKey,
    logDocId,
    datasetIdFromRegionUrl,
    countDoneForDataset,
    countWishlistForDataset,
    totalDone,
    totalWishlist,
  };
})(window);
