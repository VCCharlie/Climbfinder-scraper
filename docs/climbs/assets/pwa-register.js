/** Register service worker for installable PWA (Chrome Android). */
(function () {
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", function () {
    navigator.serviceWorker
      .register("./service-worker.js", { scope: "./" })
      .then(function (reg) {
        reg.update();
      })
      .catch(function (err) {
        console.warn("FietsKlim PWA: service worker registration failed", err);
      });
  });
})();
