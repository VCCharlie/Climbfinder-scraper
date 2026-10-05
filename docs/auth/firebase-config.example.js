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
  githubImport: {
    enabled: false,
    repo: "VCCharlie/Climbfinder-scraper",
    region: "europe-west1",
  },
};
