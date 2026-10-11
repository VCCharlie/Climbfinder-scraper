/**
 * Copy to firebase-config.js and fill in your Firebase web app config.
 * Console: Project settings → Your apps → Web app → firebaseConfig
 *
 * Authorized domains (Authentication → Settings): add e.g.
 *   vccharlie.github.io
 *   localhost
 */
window.FIETSKLIM_AUTH_CONFIG = {
  /** Paste the full object from Firebase Console; extra keys are fine. */
  firebase: {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT_ID.appspot.com",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID",
    measurementId: "G-XXXXXXXXXX",
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
  /**
   * Optional: one-click GitHub Actions import from climbs/import.html.
   * Requires deployed Firebase Function requestClimbfinderImport — see docs/auth/GITHUB_IMPORT.md
   */
  /**
   * Climb “gedaan” logboek (climbs/index.html).
   * useFirestore: true → Firestore **Native mode** (niet Datastore mode).
   * false → alleen localStorage in deze browser.
   */
  climbLog: {
    useFirestore: true,
  },
  /** Strava (climbs/index.html): OAuth + proef-sync via Cloud Functions — zie docs/auth/STRAVA.md */
  strava: {
    enabled: true,
  },
  githubImport: {
    /** Zet true na deploy van requestClimbfinderImport + github.pat in Functions config. */
    enabled: true,
    repo: "VCCharlie/Climbfinder-scraper",
    region: "europe-west1",
  },
  /**
   * Carto Voyager (climbs/index.html): plak je CARTO Basemaps API-sleutel tussen de aanhalingstekens.
   * Gratis tier (~5M tegels/maand) — https://carto.com/basemaps/apikey/
   * Referer-restrictie: zie docs/climbs/MAP_TILES.md (vccharlie.github.io, localhost).
   */
  mapTiles: {
    cartoApiKey: "",
  },
  /** Alternatief veld (zelfde sleutel als mapTiles.cartoApiKey). */
  // CARTO_API_KEY: "",
};
