/**
 * Copy to firebase-config.js and fill in your Firebase web app config.
 * Console: Project settings → Your apps → Web app → firebaseConfig
 *
 * Authorized domains (Authentication → Settings): add e.g.
 *   vccharlie.github.io
 *   localhost
 */
window.FIETSKLIM_AUTH_CONFIG = {
  firebase: {
      apiKey: "AIzaSyCqxyveEFIERvxDopjdM9b0enl8TRsWVjY",
      authDomain: "climb-database.firebaseapp.com",
      projectId: "climb-database",
      storageBucket: "climb-database.firebasestorage.app",
      messagingSenderId: "661070985234",
      appId: "1:661070985234:web:7778d281be324f730480cb",
      measurementId: "G-FJTF78HND8"
  },
  /** Only these Google accounts may use the site (personal use). */
  allowedEmails: ["vr.deruiter@gmail.com"],
  /**
   * Optional: load climb JSON from Firebase Storage (recommended for real protection).
   * Upload docs/climbs/data/*.json to Storage path climbs/data/ and set useStorage: true.
   * See docs/auth/SETUP.md for storage.rules.
   */
  useStorage: false,
  storageDataPrefix: "climbs/data",
  /** One-click GitHub Actions import (requires deployed requestClimbfinderImport + github.pat in Functions). */
  climbLog: {
    /** Zet true na Firestore **Native mode** (niet Datastore). false = localStorage per browser. */
    useFirestore: false,
  },
  githubImport: {
    enabled: true,
    repo: "VCCharlie/Climbfinder-scraper",
    region: "europe-west1",
  },
  /**
   * Carto Voyager: plak hier alleen je CARTO Basemaps API-sleutel (Firebase staat al ingevuld).
   * Aanvragen: https://carto.com/basemaps/apikey/ — zie docs/climbs/MAP_TILES.md
   */
  mapTiles: {
    cartoApiKey: "cb1_4h4w_1_2e6e2d0ac33b270f2dace12d",
  },
};
