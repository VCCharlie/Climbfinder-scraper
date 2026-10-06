/** Register service worker for installable PWA (Chrome Android). */
(function () {
  if (!("serviceWorker" in navigator)) return;

  function climbsScopeUrl() {
    return new URL("./", window.location.href).href;
  }

  function swScriptUrl() {
    return new URL("service-worker.js", window.location.href).href;
  }

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
              reg.active && reg.active.scriptURL && reg.active.scriptURL !== scriptUrl;
            if (inClimbsTree && wrongScript) {
              return reg.unregister();
            }
            return undefined;
          })
        );
      })
      .then(function () {
        return navigator.serviceWorker.register("./service-worker.js", { scope: "./" });
      })
      .then(function (reg) {
        reg.update();
      })
      .catch(function (err) {
        console.warn("FietsKlim PWA: service worker registration failed", err);
      });
  });
})();
