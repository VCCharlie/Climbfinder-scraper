/**
 * Firebase Web config — project climb-database (Firestore Native, eur3).
 * Console: Project settings → Your apps → Web app → firebaseConfig (volledig blok plakken).
 *
 * Authorized domains: vccharlie.github.io, localhost
 */
window.FIETSKLIM_AUTH_CONFIG = {
  firebase: {
    apiKey: "PASTE_FROM_FIREBASE_CONSOLE",
    authDomain: "climb-database.firebaseapp.com",
    projectId: "climb-database",
    storageBucket: "climb-database.firebasestorage.app",
    messagingSenderId: "PASTE_FROM_FIREBASE_CONSOLE",
    appId: "PASTE_FROM_FIREBASE_CONSOLE",
    measurementId: "G-PASTE_OPTIONAL",
  },
  allowedEmails: ["vr.deruiter@gmail.com"],
  useStorage: false,
  storageDataPrefix: "climbs/data",
  climbLog: {
    /** true = Firestore climb-database; false = localStorage per browser */
    useFirestore: true,
  },
  strava: {
    enabled: true,
  },
  githubImport: {
    enabled: true,
    repo: "VCCharlie/Climbfinder-scraper",
    region: "europe-west1",
  },
};
