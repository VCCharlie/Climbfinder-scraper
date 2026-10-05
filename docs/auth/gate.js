/**
 * Firebase Google sign-in gate — personal use, allowlisted email only.
 * Loads before any app scripts; dispatches fietsklim-authenticated when OK.
 */
(function () {
  const DEFAULT_ALLOWED = ["vr.deruiter@gmail.com"];

  function $(id) {
    return document.getElementById(id);
  }

  function showError(msg) {
    const el = $("fietsklim-auth-error");
    if (el) {
      el.textContent = msg;
      el.classList.add("visible");
    }
  }

  function hideGate() {
    if (document.body.classList.contains("fietsklim-unlocked")) {
      return;
    }
    $("fietsklim-auth-gate")?.classList.add("fietsklim-auth-hidden");
    document.body.classList.remove("fietsklim-locked");
    document.body.classList.add("fietsklim-unlocked");
    window.__FIETSKLIM_AUTH_READY = true;
    window.dispatchEvent(new CustomEvent("fietsklim-authenticated"));
  }

  function showGate() {
    $("fietsklim-auth-gate")?.classList.remove("fietsklim-auth-hidden");
    document.body.classList.add("fietsklim-locked");
    document.body.classList.remove("fietsklim-unlocked");
    window.__FIETSKLIM_AUTH_READY = false;
  }

  function isEmailAllowed(email, allowed) {
    if (!email) return false;
    const norm = email.trim().toLowerCase();
    return allowed.some((e) => e.trim().toLowerCase() === norm);
  }

  function renderUserBar(user) {
    const bar = $("fietsklim-auth-userbar");
    if (!bar) return;
    bar.innerHTML = `${user.email || user.displayName || "Ingelogd"} <button type="button" id="fietsklim-signout">Uitloggen</button>`;
    $("fietsklim-signout")?.addEventListener("click", () => {
      firebase.auth().signOut();
    });
  }

  function failConfig(message) {
    showGate();
    showError(message);
    const btn = $("fietsklim-google-btn");
    if (btn) btn.disabled = true;
  }

  document.addEventListener("DOMContentLoaded", function () {
    const cfg = window.FIETSKLIM_AUTH_CONFIG;
    if (!cfg || !cfg.firebase || !cfg.firebase.apiKey || cfg.firebase.apiKey === "YOUR_API_KEY") {
      failConfig(
        "Firebase is nog niet geconfigureerd. Kopieer auth/firebase-config.example.js naar auth/firebase-config.js en vul je projectgegevens in. Zie auth/SETUP.md."
      );
      return;
    }

    if (typeof firebase === "undefined") {
      failConfig("Firebase SDK niet geladen.");
      return;
    }

    const allowed = cfg.allowedEmails?.length ? cfg.allowedEmails : DEFAULT_ALLOWED;

    if (!firebase.apps.length) {
      firebase.initializeApp(cfg.firebase);
    }
    const auth = firebase.auth();
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

    $("fietsklim-google-btn")?.addEventListener("click", function () {
      const btn = this;
      btn.disabled = true;
      $("fietsklim-auth-error")?.classList.remove("visible");
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      auth
        .signInWithPopup(provider)
        .then(function (result) {
          const email = result.user?.email;
          if (!isEmailAllowed(email, allowed)) {
            return auth.signOut().then(function () {
              showError("Geen toegang: dit account is niet toegestaan voor deze persoonlijke site.");
              showGate();
            });
          }
          renderUserBar(result.user);
          /* hideGate + app start via onAuthStateChanged (avoids double init) */
        })
        .catch(function (err) {
          showError(err.message || "Inloggen mislukt.");
          showGate();
        })
        .finally(function () {
          btn.disabled = false;
        });
    });

    auth.onAuthStateChanged(function (user) {
      if (!user) {
        showGate();
        return;
      }
      if (!isEmailAllowed(user.email, allowed)) {
        auth.signOut();
        showError("Geen toegang: alleen het eigenaar-account is toegestaan.");
        showGate();
        return;
      }
      renderUserBar(user);
      hideGate();
    });
  });
})();
