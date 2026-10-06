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
    apiKey: "AIzaSyDqkP-PZnYi0r91xvE3NsK4NQEsSFOTLSk",
    authDomain: "climbfinder-scraper.firebaseapp.com",
    projectId: "climbfinder-scraper",
    storageBucket: "climbfinder-scraper.appspot.com",
    appId: "1:267954743255:web:81e3b812e869cadd850d92",
    messagingSenderId: "267954743255",
    measurementId: "G-P0PKTM6FX2"
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
};
