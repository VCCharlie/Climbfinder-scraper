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
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT_ID.appspot.com",
    appId: "YOUR_APP_ID",
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
};
