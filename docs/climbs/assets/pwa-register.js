/** Register service worker for installable PWA (Chrome Android) + forced update reload. */
(function () {
  if (!("serviceWorker" in navigator)) return;

  var BUILD_STAMP = "20261012mapload1";
  var SW_RELOAD_SESSION_KEY = "fietsklim-sw-reloading";

  function climbsScopeUrl() {
    return new URL("./", window.location.href).href;
  }

  function buildVersionFromScript() {
    var scripts = document.getElementsByTagName("script");
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].src;
      if (!src || src.indexOf("pwa-register.js") === -1) continue;
      try {
        return new URL(src).searchParams.get("v") || "";
      } catch (e) {
        return "";
      }
    }
    return "";
  }

  function swScriptUrl() {
    var v = buildVersionFromScript();
    var base = new URL("service-worker.js", window.location.href);
    if (v) base.searchParams.set("v", v);
    return base.href;
  }

  function isStandaloneDisplay() {
    try {
      if (window.matchMedia("(display-mode: standalone)").matches) return true;
    } catch (e) {
      /* ignore */
    }
    if (window.navigator.standalone === true) return true;
    if (document.referrer && document.referrer.indexOf("android-app://") === 0) return true;
    return false;
  }

  function applyStandaloneMarkers() {
    document.documentElement.setAttribute("data-build", BUILD_STAMP);
    if (isStandaloneDisplay()) {
      document.documentElement.classList.add("standalone");
    }
  }

  applyStandaloneMarkers();
  if (typeof console !== "undefined" && console.info) {
    console.info("FietsKlim build:", BUILD_STAMP, document.documentElement.classList.contains("standalone") ? "(PWA standalone)" : "");
  }

  function postSkipWaiting(worker) {
    if (!worker) return;
    try {
      worker.postMessage({ type: "SKIP_WAITING" });
    } catch (e) {
      console.warn("FietsKlim PWA: SKIP_WAITING failed", e);
    }
  }

  function trackWaitingWorker(reg) {
    if (reg.waiting && navigator.serviceWorker.controller) {
      postSkipWaiting(reg.waiting);
    }
    reg.addEventListener("updatefound", function () {
      var installing = reg.installing;
      if (!installing) return;
      installing.addEventListener("statechange", function () {
        if (installing.state !== "installed") return;
        if (!navigator.serviceWorker.controller) return;
        postSkipWaiting(reg.waiting || installing);
      });
    });
  }

  function activeSwVersionMismatch(reg, scriptUrl) {
    if (!reg.active || !reg.active.scriptURL) return false;
    try {
      var expected = new URL(scriptUrl);
      var active = new URL(reg.active.scriptURL);
      if (expected.pathname !== active.pathname) return true;
      var expectedV = expected.searchParams.get("v") || "";
      var activeV = active.searchParams.get("v") || "";
      return expectedV !== activeV;
    } catch (e) {
      return reg.active.scriptURL.split("?")[0] !== scriptUrl.split("?")[0];
    }
  }

  var controllerReloadScheduled = false;
  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (controllerReloadScheduled) return;
    if (sessionStorage.getItem(SW_RELOAD_SESSION_KEY)) return;
    sessionStorage.setItem(SW_RELOAD_SESSION_KEY, "1");
    controllerReloadScheduled = true;
    window.location.reload();
  });

  function registerAndUpdateSw() {
    var scope = climbsScopeUrl();
    var scriptUrl = swScriptUrl();

    navigator.serviceWorker
      .getRegistrations()
      .then(function (regs) {
        return Promise.all(
          regs.map(function (reg) {
            var inClimbsTree = reg.scope.indexOf("/climbs") !== -1;
            if (inClimbsTree && activeSwVersionMismatch(reg, scriptUrl)) {
              return reg.unregister();
            }
            return undefined;
          })
        );
      })
      .then(function () {
        return navigator.serviceWorker.register(scriptUrl, { scope: "./" });
      })
      .then(function (reg) {
        trackWaitingWorker(reg);
        return reg.update().then(function () {
          trackWaitingWorker(reg);
          return reg;
        });
      })
      .then(function (reg) {
        if (!reg.waiting && !reg.installing) {
          sessionStorage.removeItem(SW_RELOAD_SESSION_KEY);
        }
      })
      .catch(function (err) {
        console.warn("FietsKlim PWA: service worker registration failed", err);
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", registerAndUpdateSw);
  } else {
    registerAndUpdateSw();
  }

  window.addEventListener("pageshow", function (event) {
    if (event.persisted) registerAndUpdateSw();
  });
})();
