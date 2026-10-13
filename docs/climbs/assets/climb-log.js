/**
 * Fase 1 — handmatig logboek: welke klimmen zijn gedaan / op wishlist (per Google-account).
 * Firestore: users/{uid}/climbLog/{datasetId__climbId}
 * Multi-device: per veld last-write-wins via doneUpdatedAt / wishlistUpdatedAt (ms).
 * Fallback: localStorage als Firestore niet beschikbaar is.
 */
(function (global) {
  const STORAGE_VERSION = 1;
  const FIRESTORE_PREF_KEY = "fietsklim-log-use-firestore";
  const DEVICE_MERGE_KEY_PREFIX = "fietsklim-log-device-merged-lww-";

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
        line: `Sync: alleen dit apparaat (localStorage) · ${counts} — zet cloud aan voor dezelfde lijst overal`,
        ok: true,
        requestedFirestore: false,
        activeMode: active,
      };
    }
    if (active === "firestore") {
      return {
        line: `Sync: Firestore (cloud) · zelfde gedaan/wishlist op alle apparaten · ${counts}`,
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

  function nowMs() {
    return Date.now();
  }

  function timestampMillis(v) {
    if (v == null) return 0;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v.toMillis === "function") return v.toMillis();
    if (typeof v === "string") {
      const t = Date.parse(v);
      return Number.isFinite(t) ? t : 0;
    }
    return 0;
  }

  function timestampsFromRow(row) {
    const fallback = timestampMillis(row?.updatedAt) || nowMs();
    return {
      doneUpdatedAt: timestampMillis(row?.doneUpdatedAt) || fallback,
      wishlistUpdatedAt: timestampMillis(row?.wishlistUpdatedAt) || fallback,
    };
  }

  /**
   * Per-veld LWW (milliseconden). Oudere Firestore-docs zonder timestamps tellen als 0.
   */
  function mergeFlagsLww(existing, patch) {
    const base = existing || {};
    let done = Boolean(base.done);
    let wishlist = Boolean(base.wishlist);
    let doneUpdatedAt = timestampMillis(base.doneUpdatedAt);
    let wishlistUpdatedAt = timestampMillis(base.wishlistUpdatedAt);
    let source = base.source || "manual";

    if (patch.done !== undefined) {
      const at = patch.doneUpdatedAt != null ? timestampMillis(patch.doneUpdatedAt) : nowMs();
      if (at >= doneUpdatedAt) {
        done = Boolean(patch.done);
        doneUpdatedAt = at;
        if (patch.source) source = patch.source;
      }
    }
    if (patch.wishlist !== undefined) {
      const at = patch.wishlistUpdatedAt != null ? timestampMillis(patch.wishlistUpdatedAt) : nowMs();
      if (at >= wishlistUpdatedAt) {
        wishlist = Boolean(patch.wishlist);
        wishlistUpdatedAt = at;
      }
    }
    if (patch.source && patch.done === undefined && patch.wishlist === undefined) {
      source = patch.source;
    }

    return { done, wishlist, doneUpdatedAt, wishlistUpdatedAt, source };
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

  function deviceMergeStorageKey() {
    return state.uid ? `${DEVICE_MERGE_KEY_PREFIX}${state.uid}` : "";
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
        const ts = timestampsFromRow(row);
        const ref = col.doc(logDocId(row.datasetId, row.climbId));
        batch.set(
          ref,
          {
            datasetId: row.datasetId,
            climbId: row.climbId,
            done: Boolean(row.done),
            wishlist: Boolean(row.wishlist),
            doneUpdatedAt: ts.doneUpdatedAt,
            wishlistUpdatedAt: ts.wishlistUpdatedAt,
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

  /** Eerste keer op dit apparaat: lokale vinkjes samenvoegen met bestaande cloud (LWW per veld). */
  async function mergeLocalRowsToFirestoreLww(rows) {
    let written = 0;
    for (const row of rows) {
      const ts = timestampsFromRow(row);
      await writeFirestore(row.datasetId, row.climbId, {
        done: Boolean(row.done),
        wishlist: Boolean(row.wishlist),
        doneUpdatedAt: ts.doneUpdatedAt,
        wishlistUpdatedAt: ts.wishlistUpdatedAt,
        source: row.source === "strava" ? "strava" : row.source || "migrated",
      });
      written += 1;
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
      doneUpdatedAt: 0,
      wishlistUpdatedAt: 0,
    };
    const t = nowMs();
    const next = {
      ...prev,
      ...patch,
      datasetId,
      climbId,
      done: Boolean(patch.done != null ? patch.done : prev.done),
      wishlist: Boolean(patch.wishlist != null ? patch.wishlist : prev.wishlist),
      updatedAt: new Date().toISOString(),
    };
    if (patch.done !== undefined) next.doneUpdatedAt = t;
    if (patch.wishlist !== undefined) next.wishlistUpdatedAt = t;
    const merged = mergeFlagsLww(prev, next);
    Object.assign(next, merged);
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
      doneUpdatedAt: timestampMillis(d.doneUpdatedAt),
      wishlistUpdatedAt: timestampMillis(d.wishlistUpdatedAt),
    };
    if (shouldPersist(row)) {
      state.byKey.set(climbKey(d.datasetId, d.climbId), row);
    }
  }

  async function handleFirstFirestoreSnapshot(snap) {
    const migKey = migrationStorageKey();
    const deviceKey = deviceMergeStorageKey();
    const pending = readLocalRowsFromStorage();

    if (migKey && !localStorage.getItem(migKey)) {
      if (snap.empty && pending.length) {
        try {
          const n = await migrateLocalRowsToFirestore(pending);
          localStorage.setItem(migKey, new Date().toISOString());
          console.info(`FietsKlim logboek: ${n} vinkje(s) van localStorage naar Firestore.`);
          return true;
        } catch (err) {
          console.warn("Climb log migratie:", err.message);
        }
      } else {
        localStorage.setItem(migKey, snap.empty ? "empty" : "cloud-had-data");
      }
    }

    if (deviceKey && !localStorage.getItem(deviceKey) && pending.length && !snap.empty) {
      try {
        const n = await mergeLocalRowsToFirestoreLww(pending);
        localStorage.setItem(deviceKey, new Date().toISOString());
        console.info(`FietsKlim logboek: ${n} lokale regel(s) samengevoegd met cloud (LWW).`);
        return true;
      } catch (err) {
        console.warn("Climb log device-merge:", err.message);
      }
    }
    if (deviceKey && !localStorage.getItem(deviceKey)) {
      localStorage.setItem(deviceKey, pending.length ? "no-local" : "empty");
    }
    return false;
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
                const deferred = await handleFirstFirestoreSnapshot(snap);
                if (deferred) return;
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

  /** Direct UI-update na Firestore-write (snapshot komt iets later). */
  function mergeOptimisticLocal(datasetId, climbId, patch) {
    const key = climbKey(datasetId, climbId);
    const prev = getEntry(datasetId, climbId) || {
      datasetId,
      climbId,
      done: false,
      wishlist: false,
      source: patch.source || "manual",
      doneUpdatedAt: 0,
      wishlistUpdatedAt: 0,
    };
    const t = nowMs();
    const attempt = { ...prev, ...patch, datasetId, climbId };
    if (patch.done !== undefined && patch.doneUpdatedAt == null) attempt.doneUpdatedAt = t;
    if (patch.wishlist !== undefined && patch.wishlistUpdatedAt == null) {
      attempt.wishlistUpdatedAt = t;
    }
    const merged = mergeFlagsLww(prev, attempt);
    const next = { ...prev, ...merged, datasetId, climbId };
    if (shouldPersist(next)) state.byKey.set(key, next);
    else state.byKey.delete(key);
  }

  async function writeFirestore(datasetId, climbId, patch) {
    const db = firebase.firestore();
    const ref = db
      .collection("users")
      .doc(state.uid)
      .collection("climbLog")
      .doc(logDocId(datasetId, climbId));
    const clientNow = nowMs();
    const normalizedPatch = { ...patch };
    if (normalizedPatch.done !== undefined && normalizedPatch.doneUpdatedAt == null) {
      normalizedPatch.doneUpdatedAt = clientNow;
    }
    if (normalizedPatch.wishlist !== undefined && normalizedPatch.wishlistUpdatedAt == null) {
      normalizedPatch.wishlistUpdatedAt = clientNow;
    }

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.exists
        ? snap.data()
        : {
            datasetId,
            climbId,
            done: false,
            wishlist: false,
            doneUpdatedAt: 0,
            wishlistUpdatedAt: 0,
            source: "manual",
          };
      const merged = mergeFlagsLww(existing, normalizedPatch);
      const next = {
        datasetId,
        climbId,
        done: merged.done,
        wishlist: merged.wishlist,
        doneUpdatedAt: merged.doneUpdatedAt,
        wishlistUpdatedAt: merged.wishlistUpdatedAt,
        source: merged.source,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };
      if (shouldPersist(next)) {
        tx.set(ref, next, { merge: true });
      } else {
        tx.delete(ref);
      }
    });
  }

  async function setDone(datasetId, climbId, done) {
    if (!datasetId || !climbId) return;
    const patch = { done: !!done, source: "manual" };
    if (patch.done === true) patch.wishlist = false;
    if (state.mode === "firestore" && firebase.firestore && state.uid) {
      await writeFirestore(datasetId, climbId, patch);
      mergeOptimisticLocal(datasetId, climbId, patch);
      return;
    }
    upsertLocal(datasetId, climbId, patch);
  }

  async function setWishlist(datasetId, climbId, wishlist) {
    if (!datasetId || !climbId) return;
    const patch = { wishlist: !!wishlist };
    if (patch.wishlist === true) patch.done = false;
    if (state.mode === "firestore" && firebase.firestore && state.uid) {
      await writeFirestore(datasetId, climbId, patch);
      mergeOptimisticLocal(datasetId, climbId, patch);
      return;
    }
    upsertLocal(datasetId, climbId, patch);
  }

  /** Atomic update of gedaan + wishlist (één Firestore-write). */
  async function setFlags(datasetId, climbId, flags) {
    if (!datasetId || !climbId) return;
    const patch = {};
    if (flags.done !== undefined) patch.done = !!flags.done;
    if (flags.wishlist !== undefined) patch.wishlist = !!flags.wishlist;
    if (patch.done === true) patch.wishlist = false;
    if (patch.wishlist === true) patch.done = false;
    if (!Object.keys(patch).length) return;
    if (flags.source) patch.source = flags.source;
    if (state.mode === "firestore" && firebase.firestore && state.uid) {
      await writeFirestore(datasetId, climbId, patch);
      mergeOptimisticLocal(datasetId, climbId, patch);
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
      const ts = timestampsFromRow(row);
      const patch = {
        done: Boolean(row.done),
        wishlist: Boolean(row.wishlist),
        doneUpdatedAt: ts.doneUpdatedAt,
        wishlistUpdatedAt: ts.wishlistUpdatedAt,
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
      if (!patch.done && !patch.wishlist) {
        skipped += 1;
        continue;
      }
      if (state.mode === "firestore" && firebase.firestore && state.uid) {
        await writeFirestore(row.datasetId, row.climbId, patch);
      } else {
        upsertLocal(row.datasetId, row.climbId, patch);
      }
      imported += 1;
    }
    return { imported, skipped };
  }

  function getMode() {
    return state.mode;
  }

  function getLogEntry(datasetId, climbId) {
    return getEntry(datasetId, climbId);
  }

  function listStravaLinked() {
    return listEntries()
      .filter((r) => r.stravaActivityId)
      .sort((a, b) => {
        const na = (a.stravaClimbName || a.climbId || "").toLowerCase();
        const nb = (b.stravaClimbName || b.climbId || "").toLowerCase();
        return na.localeCompare(nb, "nl");
      });
  }

  const NAV_BACK_STORAGE_KEY = "fietsklim-nav-back";

  const NAV_BACK_PRESETS = {
    settings: {
      href: "settings.html#stravaSettingsCard",
      label: "Terug naar Instellingen (Strava)",
    },
    logbook: {
      href: "logbook.html#stravaLinksSection",
      label: "Terug naar Logboek",
    },
  };

  async function clearStravaLink(datasetId, climbId) {
    if (!datasetId || !climbId) return;
    const row = getEntry(datasetId, climbId);
    if (!row?.stravaActivityId) return;

    const wishlist = Boolean(row.wishlist);
    const done = Boolean(row.done);
    const stravaSourced = row.source === "strava";

    if (state.mode === "firestore" && firebase.firestore && state.uid) {
      const ref = firebase
        .firestore()
        .collection("users")
        .doc(state.uid)
        .collection("climbLog")
        .doc(logDocId(datasetId, climbId));
      const snap = await ref.get();
      const data = snap.exists ? snap.data() : row;
      const w = Boolean(data.wishlist);
      const d = Boolean(data.done);
      const src = data.source === "strava";

      if (src && d && !w) {
        await ref.delete();
        dispatchChanged();
        return;
      }

      const patch = {
        stravaActivityId: firebase.firestore.FieldValue.delete(),
        stravaActivityName: firebase.firestore.FieldValue.delete(),
        stravaClimbName: firebase.firestore.FieldValue.delete(),
        stravaAscentCount: firebase.firestore.FieldValue.delete(),
        matchCoverage: firebase.firestore.FieldValue.delete(),
        stravaActivityStartAt: firebase.firestore.FieldValue.delete(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };
      if (src && d) {
        patch.done = false;
        patch.source = "manual";
        patch.doneUpdatedAt = nowMs();
      }
      const nextDone = patch.done !== undefined ? patch.done : d;
      if (!nextDone && !w) {
        await ref.delete();
      } else {
        await ref.set(patch, { merge: true });
      }
      dispatchChanged();
      return;
    }

    const next = { ...row };
    delete next.stravaActivityId;
    delete next.stravaActivityName;
    delete next.stravaClimbName;
    delete next.stravaAscentCount;
    delete next.matchCoverage;
    delete next.stravaActivityStartAt;
    if (stravaSourced && done) {
      next.done = false;
      next.source = "manual";
      next.doneUpdatedAt = nowMs();
    }
    const key = climbKey(datasetId, climbId);
    if (shouldPersist(next)) {
      state.byKey.set(key, next);
    } else {
      state.byKey.delete(key);
    }
    saveLocal();
    dispatchChanged();
  }

  function isMobileStravaClient() {
    if (typeof navigator === "undefined") return false;
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
  }

  function stravaActivityWebUrl(activityId) {
    if (!activityId) return null;
    return `https://www.strava.com/activities/${activityId}`;
  }

  /** Op mobiel: Strava-app (strava://); anders web. */
  function stravaActivityOpenUrl(activityId) {
    if (!activityId) return null;
    const id = String(activityId);
    if (isMobileStravaClient()) return `strava://activities/${id}`;
    return stravaActivityWebUrl(id);
  }

  function stravaActivityUrl(activityId) {
    return stravaActivityWebUrl(activityId);
  }

  function databaseClimbUrl(datasetId, climbId, options = {}) {
    const params = new URLSearchParams();
    if (datasetId) params.set("dataset", datasetId);
    if (climbId) params.set("climb", climbId);
    if (options.back) params.set("back", options.back);
    const qs = params.toString();
    return qs ? `index.html?${qs}` : "index.html";
  }

  function rememberNavBack(key) {
    const preset = NAV_BACK_PRESETS[key];
    if (!preset) return;
    try {
      sessionStorage.setItem(NAV_BACK_STORAGE_KEY, JSON.stringify(preset));
    } catch {
      /* ignore */
    }
  }

  function getNavBack() {
    try {
      const raw = sessionStorage.getItem(NAV_BACK_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function clearNavBack() {
    try {
      sessionStorage.removeItem(NAV_BACK_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  /** Jaar van de Strava-rit (ms), anders doneUpdatedAt. */
  function stravaRideYear(row) {
    const rideAt = timestampMillis(row?.stravaActivityStartAt);
    if (rideAt > 0) return new Date(rideAt).getFullYear();
    const doneAt = timestampMillis(row?.doneUpdatedAt);
    if (doneAt > 0) return new Date(doneAt).getFullYear();
    return null;
  }

  /** Jaar voor logboek-filters: Strava-rit, anders geklommen- of wishlist-datum. */
  function logbookEntryYear(row) {
    const rideAt = timestampMillis(row?.stravaActivityStartAt);
    if (rideAt > 0) return new Date(rideAt).getFullYear();
    if (row?.done) {
      const d = timestampMillis(row.doneUpdatedAt);
      if (d > 0) return new Date(d).getFullYear();
    }
    if (row?.wishlist) {
      const w = timestampMillis(row.wishlistUpdatedAt);
      if (w > 0) return new Date(w).getFullYear();
    }
    return null;
  }

  function formatStravaRideDate(row, locale = "nl-NL") {
    const rideAt = timestampMillis(row?.stravaActivityStartAt);
    if (rideAt <= 0) return "";
    try {
      return new Date(rideAt).toLocaleDateString(locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return "";
    }
  }

  function applyStravaActivityAnchor(anchor, activityId) {
    if (!anchor || !activityId) return;
    const url = stravaActivityOpenUrl(activityId);
    if (!url) return;
    anchor.href = url;
    anchor.rel = "noopener noreferrer";
    if (isMobileStravaClient()) {
      anchor.removeAttribute("target");
    } else {
      anchor.target = "_blank";
    }
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
    getLogEntry,
    listStravaLinked,
    clearStravaLink,
    stravaRideYear,
    logbookEntryYear,
    formatStravaRideDate,
    stravaActivityUrl,
    stravaActivityWebUrl,
    stravaActivityOpenUrl,
    isMobileStravaClient,
    applyStravaActivityAnchor,
    databaseClimbUrl,
    rememberNavBack,
    getNavBack,
    clearNavBack,
    /** @internal test hook */
    _mergeFlagsLww: mergeFlagsLww,
    _timestampMillis: timestampMillis,
  };
})(window);
