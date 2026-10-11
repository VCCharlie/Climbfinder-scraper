/** Register service worker for installable PWA (Chrome Android) + forced update reload. */
(function () {
  if (!("serviceWorker" in navigator)) return;

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

  var controllerReloadScheduled = false;
  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (controllerReloadScheduled) return;
    if (sessionStorage.getItem(SW_RELOAD_SESSION_KEY)) return;
    sessionStorage.setItem(SW_RELOAD_SESSION_KEY, "1");
    controllerReloadScheduled = true;
    window.location.reload();
  });

  window.addEventListener("load", function () {
    var scope = climbsScopeUrl();
    var scriptUrl = swScriptUrl();

    navigator.serviceWorker
      .getRegistrations()
      .then(function (regs) {
        return Promise.all(
          regs.map(function (reg) {
            var inClimbsTree = reg.scope.indexOf("/climbs") !== -1;
            var wrongScript =
              reg.active && reg.active.scriptURL && reg.active.scriptURL.split("?")[0] !== scriptUrl.split("?")[0];
            if (inClimbsTree && wrongScript) {
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
  });
})();
