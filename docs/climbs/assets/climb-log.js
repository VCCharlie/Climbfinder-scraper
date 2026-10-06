/**
 * Fase 1 — handmatig logboek: welke klimmen zijn gedaan (per Google-account).
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

  function loadLocal() {
    state.byKey.clear();
    const email = state.email;
    if (!email) return;
    try {
      const raw = localStorage.getItem(`fietsklim-climb-log-v${STORAGE_VERSION}-${email}`);
      if (!raw) return;
      const data = JSON.parse(raw);
      for (const row of data.entries || []) {
        if (row.datasetId && row.climbId && row.done) {
          state.byKey.set(climbKey(row.datasetId, row.climbId), row);
        }
      }
    } catch {
      /* ignore */
    }
  }

  function saveLocal() {
    const email = state.email;
    if (!email) return;
    const entries = [...state.byKey.values()].filter((r) => r.done);
    localStorage.setItem(
      `fietsklim-climb-log-v${STORAGE_VERSION}-${email}`,
      JSON.stringify({ version: STORAGE_VERSION, entries })
    );
  }

  function setLocal(datasetId, climbId, done) {
    const key = climbKey(datasetId, climbId);
    if (done) {
      state.byKey.set(key, {
        datasetId,
        climbId,
        done: true,
        source: "manual",
        updatedAt: new Date().toISOString(),
      });
    } else {
      state.byKey.delete(key);
    }
    saveLocal();
    dispatchChanged();
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
                const d = doc.data();
                if (d?.datasetId && d?.climbId && d.done) {
                  state.byKey.set(climbKey(d.datasetId, d.climbId), d);
                }
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
    if (!datasetId || !climbId) return false;
    return state.byKey.has(climbKey(datasetId, climbId));
  }

  async function setDone(datasetId, climbId, done) {
    if (!datasetId || !climbId) return;
    if (state.mode === "firestore" && firebase.firestore && state.uid) {
      const db = firebase.firestore();
      const ref = db
        .collection("users")
        .doc(state.uid)
        .collection("climbLog")
        .doc(logDocId(datasetId, climbId));
      if (done) {
        await ref.set(
          {
            datasetId,
            climbId,
            done: true,
            source: "manual",
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      } else {
        await ref.delete();
      }
      return;
    }
    setLocal(datasetId, climbId, done);
  }

  function countDoneForDataset(datasetId) {
    if (!datasetId) return 0;
    let n = 0;
    for (const row of state.byKey.values()) {
      if (row.datasetId === datasetId) n += 1;
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
    setDone,
    climbKey,
    logDocId,
    datasetIdFromRegionUrl,
    countDoneForDataset,
    totalDone: () => state.byKey.size,
  };
})(window);
